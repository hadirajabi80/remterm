package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is bound to the frontend; its exported methods are callable from JS
// as window.go.main.App.<Method>.
type App struct {
	ctx      context.Context
	store    *Store
	history  *cmdHistory
	mu       sync.Mutex
	sessions map[string]*Session
	launch   launchState
	logs     *logStore
	tunnels  tunnelManager
	files    fileManager
	rdp      *rdpEngine
	relay    rdpRelay // in-tab Remote Desktop through IronRDP (macOS)
}

func NewApp() *App {
	a := &App{
		sessions: make(map[string]*Session),
		logs:     &logStore{},
		tunnels:  tunnelManager{running: map[string]*runningTunnel{}, status: map[string]TunnelStatus{}},
		files:    fileManager{sessions: map[string]*fileSession{}, transfers: map[string]context.CancelFunc{}},
	}
	a.rdp = newRdpEngine(a)
	return a
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	s, err := OpenStore()
	if err != nil {
		wruntime.LogErrorf(ctx, "open store: %v", err)
		s = &Store{
			path: filepath.Join(os.TempDir(), "remterm-data.json"),
			data: storeData{Snippets: defaultSnippets()},
		}
	}
	a.store = s
	a.history = openCmdHistory()
	a.logs = openLogStore()
	a.startAutoTunnels()
}

func (a *App) shutdown(context.Context) {
	if a.history != nil {
		a.history.flush()
	}
	a.stopAllTunnels()
	a.rdp.stop()
	a.mu.Lock()
	all := make([]*Session, 0, len(a.sessions))
	for _, s := range a.sessions {
		all = append(all, s)
	}
	a.mu.Unlock()
	for _, s := range all {
		a.closeSession(s, "Application closed", false, -1)
	}
}

// Platform is the OS Remterm runs on ("windows", "darwin", "linux").
func (a *App) Platform() string { return runtime.GOOS }

// ---- Hosts ----

func (a *App) ListHosts() []Host {
	return a.store.Hosts()
}

// SaveHost creates or updates a host. A non-empty secret is written to the
// OS credential store; an empty one keeps whatever is already saved.
func (a *App) SaveHost(h Host, secret, proxyPassword string) (Host, error) {
	h.Address = strings.TrimSpace(h.Address)
	h.User = strings.TrimSpace(h.User)
	h.Name = strings.TrimSpace(h.Name)
	h.Group = strings.TrimSpace(h.Group)
	if h.Protocol == "serial" && h.Address == "" && h.Serial != nil {
		h.Address = h.Serial.Port
	}
	if h.Address == "" {
		return Host{}, errors.New("address is required")
	}
	if h.Port <= 0 || h.Port > 65535 {
		h.Port = 22
	}
	if h.Name == "" {
		h.Name = h.Address
	}
	if h.AuthMethod == "" {
		h.AuthMethod = "auto"
	}
	if h.ID == "" {
		h.ID = newID()
	}
	if h.JumpHostID == h.ID {
		h.JumpHostID = ""
	}

	h.HasSecret, h.LastUsed = false, 0
	if old, ok := a.store.Host(h.ID); ok {
		h.HasSecret, h.LastUsed = old.HasSecret, old.LastUsed
		if h.Proxy != nil && old.Proxy != nil {
			h.Proxy.HasSecret = old.Proxy.HasSecret
		}
	}
	h.Tags = normalizeTags(h.Tags)
	if h.Proxy != nil && strings.TrimSpace(h.Proxy.Host) == "" {
		h.Proxy = nil
		deleteNamedSecret("proxy:" + h.ID)
	}
	if h.Proxy != nil && proxyPassword != "" {
		if err := setNamedSecret("proxy:"+h.ID, proxyPassword); err != nil {
			return Host{}, err
		}
		h.Proxy.HasSecret = true
	}
	if h.Protocol == "serial" && (h.Serial == nil || h.Serial.Port == "") {
		return Host{}, errors.New("choose a serial port")
	}
	if secret != "" {
		if err := setSecret(h.ID, secret); err != nil {
			return Host{}, fmt.Errorf("save password to credential store: %w", err)
		}
		h.HasSecret = true
	}
	return h, a.store.PutHost(h)
}

func (a *App) ClearSecret(id string) error {
	deleteSecret(id)
	h, ok := a.store.Host(id)
	if !ok {
		return nil
	}
	h.HasSecret = false
	return a.store.PutHost(h)
}

func (a *App) DeleteHost(id string) error {
	deleteSecret(id)
	return a.store.DeleteHost(id)
}

func (a *App) PickKeyFile() (string, error) {
	opts := wruntime.OpenDialogOptions{Title: "Select private key", ShowHiddenFiles: true}
	if home, err := os.UserHomeDir(); err == nil {
		dir := filepath.Join(home, ".ssh")
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			opts.DefaultDirectory = dir
		}
	}
	return wruntime.OpenFileDialog(a.ctx, opts)
}

// ---- Snippets ----

func (a *App) ListSnippets() []Snippet {
	return a.store.Snippets()
}

func (a *App) SaveSnippet(s Snippet) (Snippet, error) {
	s.Command = strings.TrimRight(s.Command, "\r\n ")
	s.Name = strings.TrimSpace(s.Name)
	s.Group = strings.TrimSpace(s.Group)
	s.Description = strings.TrimSpace(s.Description)
	if strings.TrimSpace(s.Command) == "" {
		return Snippet{}, errors.New("command is required")
	}
	if s.Name == "" {
		s.Name = strings.SplitN(s.Command, "\n", 2)[0]
		if len(s.Name) > 40 {
			s.Name = s.Name[:40] + "…"
		}
	}
	if s.ID == "" {
		s.ID = newID()
	}
	return s, a.store.PutSnippet(s)
}

func (a *App) DeleteSnippet(id string) error {
	return a.store.DeleteSnippet(id)
}

// ---- Settings ----

// GetSettings returns the UI preferences as JSON ("" when never saved).
func (a *App) GetSettings() string {
	return string(a.store.Settings())
}

func (a *App) SaveSettings(raw string) error {
	if len(raw) > 12<<20 {
		return errors.New("settings too large (custom background image?)")
	}
	if !json.Valid([]byte(raw)) {
		return errors.New("invalid settings JSON")
	}
	return a.store.PutSettings(json.RawMessage(raw))
}

func normalizeTags(tags []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, t := range tags {
		t = strings.TrimSpace(t)
		if t != "" && !seen[strings.ToLower(t)] {
			seen[strings.ToLower(t)] = true
			out = append(out, t)
		}
	}
	sort.Strings(out)
	return out
}

// emit sends an event to the UI; without a window (tests) it does nothing.
func (a *App) emit(name string, data ...interface{}) {
	if a.ctx != nil {
		wruntime.EventsEmit(a.ctx, name, data...)
	}
}
