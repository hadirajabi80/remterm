package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// CmdEntry is one command as run on one target. HostKey is "ssh:<hostId>",
// "spec:<user@host>" or "local:<shellId>".
type CmdEntry struct {
	Command  string `json:"command"`
	HostKey  string `json:"hostKey"`
	Count    int    `json:"count"`
	LastUsed int64  `json:"lastUsed"` // unix ms
}

const maxHistory = 5000

// Commands that look like they carry credentials are never stored. A
// leading space is the shell convention for "don't record this".
var secretRe = regexp.MustCompile(`(?i)(pass(word|wd)?|secret|token|api[_-]?key)\s*[=:]\s*\S|--?(password|passwd|token|secret)[=\s]\S`)

func recordable(cmd string) bool {
	t := strings.TrimSpace(cmd)
	return t != "" && len(t) <= 2000 && !strings.HasPrefix(cmd, " ") && !secretRe.MatchString(t)
}

// cmdHistory lives in its own file (history.json) because it changes on
// every command; writes are debounced.
type cmdHistory struct {
	mu      sync.Mutex
	path    string
	entries []CmdEntry
	timer   *time.Timer
}

func openCmdHistory() *cmdHistory {
	h := &cmdHistory{}
	dir, err := dataDir()
	if err != nil {
		return h // in-memory only
	}
	h.path = filepath.Join(dir, "history.json")
	if b, err := os.ReadFile(h.path); err == nil {
		_ = json.Unmarshal(b, &h.entries)
	}
	return h
}

func (h *cmdHistory) saveSoonLocked() {
	if h.path == "" {
		return
	}
	if h.timer != nil {
		h.timer.Stop()
	}
	h.timer = time.AfterFunc(time.Second, h.flush)
}

func (h *cmdHistory) flush() {
	h.mu.Lock()
	b, err := json.Marshal(h.entries)
	path := h.path
	h.mu.Unlock()
	if err != nil || path == "" {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}

func (h *cmdHistory) add(command, hostKey string) {
	if !recordable(command) {
		return
	}
	command = strings.TrimSpace(command)
	now := time.Now().UnixMilli()
	h.mu.Lock()
	defer h.mu.Unlock()
	for i := range h.entries {
		if h.entries[i].Command == command && h.entries[i].HostKey == hostKey {
			h.entries[i].Count++
			h.entries[i].LastUsed = now
			h.saveSoonLocked()
			return
		}
	}
	h.entries = append(h.entries, CmdEntry{Command: command, HostKey: hostKey, Count: 1, LastUsed: now})
	if len(h.entries) > maxHistory {
		sort.Slice(h.entries, func(i, j int) bool { return h.entries[i].LastUsed > h.entries[j].LastUsed })
		h.entries = h.entries[:maxHistory]
	}
	h.saveSoonLocked()
}

func (h *cmdHistory) list() []CmdEntry {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]CmdEntry{}, h.entries...)
}

func (h *cmdHistory) remove(command string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	kept := h.entries[:0]
	for _, e := range h.entries {
		if e.Command != command {
			kept = append(kept, e)
		}
	}
	h.entries = kept
	h.saveSoonLocked()
}

func (h *cmdHistory) clear() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.entries = nil
	h.saveSoonLocked()
}

// ---- bound API ----

func (a *App) ListCommandHistory() []CmdEntry {
	return a.history.list()
}

func (a *App) AddCommandHistory(command, hostKey string) error {
	if hostKey == "" {
		return errors.New("missing host key")
	}
	a.history.add(command, hostKey)
	return nil
}

// DeleteCommandHistory forgets a command on every host.
func (a *App) DeleteCommandHistory(command string) {
	a.history.remove(command)
}

func (a *App) ClearCommandHistory() {
	a.history.clear()
}
