package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Session logs record what a terminal showed (raw bytes, so a log replays
// with colors). Passwords typed at no-echo prompts are never shown and so
// never recorded. Per host the newest logs are kept; bookmarked logs stay
// until un-bookmarked.

type LogEntry struct {
	ID         string `json:"id"`
	HostKey    string `json:"hostKey"`
	Title      string `json:"title"`
	Started    int64  `json:"started"`
	Ended      int64  `json:"ended"` // 0 while running
	Size       int64  `json:"size"`
	Bookmarked bool   `json:"bookmarked"`
	Comment    string `json:"comment"`
}

const (
	logsKeptPerHost = 5
	maxLogBytes     = 20 << 20
)

type logStore struct {
	mu      sync.Mutex
	dir     string
	entries []LogEntry
	enabled atomic.Bool
	open    map[string]*sessionLog // logs of sessions still running
}

func openLogStore() *logStore {
	l := &logStore{open: map[string]*sessionLog{}}
	l.enabled.Store(true)
	d, err := dataDir()
	if err != nil {
		return l
	}
	l.dir = filepath.Join(d, "logs")
	if os.MkdirAll(l.dir, 0o700) != nil {
		l.dir = ""
		return l
	}
	if b, err := os.ReadFile(filepath.Join(l.dir, "index.json")); err == nil {
		_ = json.Unmarshal(b, &l.entries)
	}
	// Sessions running when Remterm quit never got an end time.
	for i := range l.entries {
		if l.entries[i].Ended == 0 {
			l.entries[i].Ended = l.entries[i].Started
			if st, err := os.Stat(l.file(l.entries[i].ID)); err == nil {
				l.entries[i].Ended = st.ModTime().UnixMilli()
				l.entries[i].Size = st.Size()
			}
		}
	}
	return l
}

func (l *logStore) file(id string) string { return filepath.Join(l.dir, id+".log") }

func (l *logStore) saveLocked() {
	if l.dir == "" {
		return
	}
	if b, err := json.Marshal(l.entries); err == nil {
		tmp := filepath.Join(l.dir, "index.json.tmp")
		if os.WriteFile(tmp, b, 0o600) == nil {
			_ = os.Rename(tmp, filepath.Join(l.dir, "index.json"))
		}
	}
}

type sessionLog struct {
	store *logStore
	id    string
	mu    sync.Mutex
	f     *os.File
	size  int64
	// truncated is set once the size cap is hit and the marker written.
	truncated bool
}

func (l *logStore) start(hostKey, title string) *sessionLog {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.enabled.Load() || l.dir == "" {
		return nil
	}
	e := LogEntry{ID: newID(), HostKey: hostKey, Title: title, Started: time.Now().UnixMilli()}
	f, err := os.OpenFile(l.file(e.ID), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil
	}
	s := &sessionLog{store: l, id: e.ID, f: f}
	if l.open == nil {
		l.open = map[string]*sessionLog{}
	}
	l.open[e.ID] = s
	l.entries = append(l.entries, e)
	l.pruneLocked(hostKey)
	l.saveLocked()
	return s
}

// pruneLocked keeps the newest unbookmarked logs per host. Logs of running
// sessions are left alone (Windows will not delete an open file); finish
// prunes again once the session ends.
func (l *logStore) pruneLocked(hostKey string) {
	var mine []int
	for i, e := range l.entries {
		if e.HostKey == hostKey && !e.Bookmarked && l.open[e.ID] == nil {
			mine = append(mine, i)
		}
	}
	if len(mine) <= logsKeptPerHost {
		return
	}
	sort.Slice(mine, func(a, b int) bool { return l.entries[mine[a]].Started > l.entries[mine[b]].Started })
	drop := map[string]bool{}
	for _, i := range mine[logsKeptPerHost:] {
		drop[l.entries[i].ID] = true
		_ = os.Remove(l.file(l.entries[i].ID))
	}
	kept := l.entries[:0]
	for _, e := range l.entries {
		if !drop[e.ID] {
			kept = append(kept, e)
		}
	}
	l.entries = kept
}

func (s *sessionLog) write(b []byte) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f == nil || s.truncated || !s.store.enabled.Load() {
		return
	}
	if s.size+int64(len(b)) > maxLogBytes {
		n, _ := s.f.Write([]byte("\r\n[log truncated at 20 MB]\r\n"))
		s.size += int64(n)
		s.truncated = true
		return
	}
	n, _ := s.f.Write(b)
	s.size += int64(n)
}

func (s *sessionLog) finish() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.f != nil {
		s.f.Close()
		s.f = nil
	}
	size := s.size
	s.mu.Unlock()
	l := s.store
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.open, s.id)
	for i := range l.entries {
		if l.entries[i].ID == s.id {
			l.entries[i].Ended = time.Now().UnixMilli()
			l.entries[i].Size = size
			l.pruneLocked(l.entries[i].HostKey)
			break
		}
	}
	l.saveLocked()
}

// ---- bound API ----

func (a *App) ListLogs() []LogEntry {
	a.logs.mu.Lock()
	defer a.logs.mu.Unlock()
	out := append([]LogEntry{}, a.logs.entries...)
	sort.Slice(out, func(i, j int) bool { return out[i].Started > out[j].Started })
	return out
}

// ReadLog returns a log's raw bytes, base64-encoded, for replay in a terminal.
func (a *App) ReadLog(id string) (string, error) {
	if a.logs.dir == "" {
		return "", errors.New("logs are unavailable")
	}
	b, err := os.ReadFile(a.logs.file(filepath.Base(id)))
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(b), nil
}

func (a *App) SetLogBookmark(id string, bookmarked bool, comment string) error {
	l := a.logs
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := range l.entries {
		if l.entries[i].ID == id {
			l.entries[i].Bookmarked = bookmarked
			l.entries[i].Comment = strings.TrimSpace(comment)
			if !bookmarked {
				l.pruneLocked(l.entries[i].HostKey)
			}
			break
		}
	}
	l.saveLocked()
	return nil
}

func (a *App) DeleteLog(id string) error {
	l := a.logs
	l.mu.Lock()
	defer l.mu.Unlock()
	// Close a running session's file first, or Windows refuses the delete;
	// its later writes then become no-ops.
	if s := l.open[id]; s != nil {
		s.mu.Lock()
		if s.f != nil {
			s.f.Close()
			s.f = nil
		}
		s.mu.Unlock()
		delete(l.open, id)
	}
	l.entries = without(l.entries, id, func(e LogEntry) string { return e.ID })
	_ = os.Remove(l.file(filepath.Base(id)))
	l.saveLocked()
	return nil
}

func (a *App) SetLogging(enabled bool) {
	a.logs.enabled.Store(enabled)
}

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_=>]`)

// plainText turns raw terminal output into readable text.
func plainText(b []byte) string {
	s := ansiRe.ReplaceAllString(string(b), "")
	s = strings.ReplaceAll(s, "\r\n", "\n")
	var out strings.Builder
	var stack []rune
	for _, line := range strings.Split(s, "\n") {
		// A bare \r rewrites the line (keep what was written last; a
		// trailing one changes nothing). \b erases one character.
		cr := false
		stack = stack[:0]
		for _, r := range line {
			if r == '\r' {
				cr = true
				continue
			}
			if cr {
				stack, cr = stack[:0], false
			}
			if r == '\b' {
				if len(stack) > 0 {
					stack = stack[:len(stack)-1]
				}
			} else {
				stack = append(stack, r)
			}
		}
		out.WriteString(string(stack))
		out.WriteByte('\n')
	}
	return out.String()
}

// ExportLog saves a log as plain text where the user chooses.
func (a *App) ExportLog(id string) (string, error) {
	var e LogEntry
	found := false
	for _, x := range a.ListLogs() {
		if x.ID == id {
			e, found = x, true
		}
	}
	if !found {
		return "", errors.New("log no longer exists")
	}
	b, err := os.ReadFile(a.logs.file(filepath.Base(id)))
	if err != nil {
		return "", err
	}
	name := strings.Map(func(r rune) rune {
		switch {
		case r < 0x20 || strings.ContainsRune(`<>:"/\|?*—`, r):
			return '-'
		case r == ' ':
			return '_'
		}
		return r
	}, e.Title)
	name = strings.TrimRight(name, ". ")
	path, err := wruntime.SaveFileDialog(a.ctx, wruntime.SaveDialogOptions{
		Title:           "Export session log",
		DefaultFilename: name + "_" + time.UnixMilli(e.Started).Format("2006-01-02_1504") + ".txt",
		Filters:         []wruntime.FileFilter{{DisplayName: "Text files", Pattern: "*.txt"}},
	})
	if err != nil || path == "" {
		return "", err
	}
	return path, os.WriteFile(path, []byte(plainText(b)), 0o600)
}
