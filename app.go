package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
}

func NewApp() *App {
	return &App{sessions: make(map[string]*Session)}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	s, err := OpenStore()
	if err != nil {
		wruntime.LogErrorf(ctx, "open store: %v", err)
		s = &Store{
			path: filepath.Join(os.TempDir(), "termora-data.json"),
			data: storeData{Snippets: defaultSnippets()},
		}
	}
	a.store = s
	a.history = openCmdHistory()
}

func (a *App) shutdown(context.Context) {
	if a.history != nil {
		a.history.flush()
	}
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

// ---- Hosts ----

func (a *App) ListHosts() []Host {
	return a.store.Hosts()
}

// SaveHost creates or updates a host. A non-empty secret is written to the
// OS credential store; an empty one keeps whatever is already saved.
func (a *App) SaveHost(h Host, secret string) (Host, error) {
	h.Address = strings.TrimSpace(h.Address)
	h.User = strings.TrimSpace(h.User)
	h.Name = strings.TrimSpace(h.Name)
	h.Group = strings.TrimSpace(h.Group)
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
