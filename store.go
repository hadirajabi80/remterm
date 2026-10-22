package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Host is a saved SSH target.
type Host struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Group          string `json:"group"`
	Env            string `json:"env"` // "", "dev", "staging", "prod"
	Address        string `json:"address"`
	Port           int    `json:"port"`
	User           string `json:"user"`
	AuthMethod     string `json:"authMethod"` // "auto", "key", "password"
	KeyPath        string `json:"keyPath"`
	JumpHostID     string `json:"jumpHostId"`
	StartupCommand string `json:"startupCommand"`
	HasSecret      bool   `json:"hasSecret"`
	LastUsed       int64  `json:"lastUsed"` // unix ms of the last successful connection
	Favorite       bool   `json:"favorite"`

	Protocol        string        `json:"protocol"` // "ssh" (default), "telnet", "serial"
	Tags            []string      `json:"tags"`
	KeyID           string        `json:"keyId"`      // keychain key
	IdentityID      string        `json:"identityId"` // reusable credentials
	AgentForwarding bool          `json:"agentForwarding"`
	EnvVars         []EnvVar      `json:"envVars"`
	Proxy           *Proxy        `json:"proxy,omitempty"`
	Scheme          string        `json:"scheme"` // terminal color scheme override
	Serial          *SerialConfig `json:"serial,omitempty"`

	ProxySecretKey string `json:"-"` // keyring entry of the resolved proxy password
}

// Snippet is a reusable command that can be sent to a session.
// Commands may contain {{name}} or {{name:default}} placeholders that the UI
// asks for before sending.
type Snippet struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Group       string `json:"group"`
	Command     string `json:"command"`
	Description string `json:"description"`
}

type storeData struct {
	Hosts           []Host          `json:"hosts"`
	Snippets        []Snippet       `json:"snippets"`
	SnippetsVersion int             `json:"snippetsVersion"`    // built-in catalog version merged in
	Settings        json.RawMessage `json:"settings,omitempty"` // UI preferences, shape owned by the frontend
	Groups          []GroupConfig   `json:"groups"`
	Identities      []Identity      `json:"identities"`
	Keys            []KeyItem       `json:"keys"`
	Tunnels         []Tunnel        `json:"tunnels"`
	Workspaces      []Workspace     `json:"workspaces"`
}

// Store persists hosts and snippets as JSON in the user config dir.
// Secrets never go here; they live in the OS credential store.
type Store struct {
	mu   sync.Mutex
	path string
	data storeData
}

func dataDir() (string, error) {
	if d := os.Getenv("REMTERM_DATA_DIR"); d != "" { // tests
		return d, os.MkdirAll(d, 0o700)
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	base := dir
	dir = filepath.Join(base, "Remterm")
	if _, err := os.Stat(dir); errors.Is(err, os.ErrNotExist) {
		// First start after Termora: take over its hosts, keys, snippets, logs and settings.
		if old := filepath.Join(base, "Termora"); dirExists(old) {
			if err := copyDir(old, dir); err != nil {
				_ = os.RemoveAll(dir)
			}
		}
	}
	return dir, os.MkdirAll(dir, 0o700)
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// copyDir copies a folder tree (files and folders only).
func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o600)
	})
}

func OpenStore() (*Store, error) {
	dir, err := dataDir()
	if err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "data.json")}

	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		s.data = storeData{Snippets: defaultSnippets(), SnippetsVersion: snippetCatalogVersion}
		return s, s.saveLocked()
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &s.data); err != nil {
		// Keep the broken file for manual recovery and start fresh.
		_ = os.Rename(s.path, s.path+".corrupt")
		s.data = storeData{Snippets: defaultSnippets(), SnippetsVersion: snippetCatalogVersion}
		return s, s.saveLocked()
	}
	if s.data.SnippetsVersion < snippetCatalogVersion {
		s.data.Snippets = upgradeSnippets(s.data.Snippets)
		s.data.SnippetsVersion = snippetCatalogVersion
		return s, s.saveLocked()
	}
	return s, nil
}

func (s *Store) saveLocked() error {
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Store) Hosts() []Host {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := append([]Host{}, s.data.Hosts...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Group != out[j].Group {
			return out[i].Group < out[j].Group
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

func (s *Store) Host(id string) (Host, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, h := range s.data.Hosts {
		if h.ID == id {
			return h, true
		}
	}
	return Host{}, false
}

func (s *Store) PutHost(h Host) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data.Hosts {
		if s.data.Hosts[i].ID == h.ID {
			s.data.Hosts[i] = h
			return s.saveLocked()
		}
	}
	s.data.Hosts = append(s.data.Hosts, h)
	return s.saveLocked()
}

// UpdateHost applies fn to the stored host under the lock, so concurrent
// edits from the UI are not overwritten with a stale copy.
func (s *Store) UpdateHost(id string, fn func(*Host)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data.Hosts {
		if s.data.Hosts[i].ID == id {
			fn(&s.data.Hosts[i])
			return s.saveLocked()
		}
	}
	return nil
}

func (s *Store) DeleteHost(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.data.Hosts[:0]
	for _, h := range s.data.Hosts {
		if h.ID == id {
			continue
		}
		if h.JumpHostID == id {
			h.JumpHostID = ""
		}
		kept = append(kept, h)
	}
	s.data.Hosts = kept
	return s.saveLocked()
}

func (s *Store) Settings() json.RawMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append(json.RawMessage(nil), s.data.Settings...)
}

func (s *Store) PutSettings(raw json.RawMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Settings = raw
	return s.saveLocked()
}

func (s *Store) Snippets() []Snippet {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Snippet{}, s.data.Snippets...)
}

func (s *Store) PutSnippet(sn Snippet) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data.Snippets {
		if s.data.Snippets[i].ID == sn.ID {
			s.data.Snippets[i] = sn
			return s.saveLocked()
		}
	}
	s.data.Snippets = append(s.data.Snippets, sn)
	return s.saveLocked()
}

func (s *Store) DeleteSnippet(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.data.Snippets[:0]
	for _, sn := range s.data.Snippets {
		if sn.ID != id {
			kept = append(kept, sn)
		}
	}
	s.data.Snippets = kept
	return s.saveLocked()
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
