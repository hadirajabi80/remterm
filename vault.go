package main

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

// ---- vault item types ----

type EnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Proxy routes the first hop of an SSH connection. The password lives in
// the OS keyring under "proxy:<owner>".
type Proxy struct {
	Type      string `json:"type"` // "socks5" | "http"
	Host      string `json:"host"`
	Port      int    `json:"port"`
	User      string `json:"user"`
	HasSecret bool   `json:"hasSecret"`
}

type SerialConfig struct {
	Port        string `json:"port"` // COM3
	Baud        int    `json:"baud"`
	DataBits    int    `json:"dataBits"`
	StopBits    string `json:"stopBits"` // "1", "1.5", "2"
	Parity      string `json:"parity"`   // "none", "odd", "even", "mark", "space"
	FlowControl string `json:"flowControl"`
}

// GroupConfig holds defaults for every host in a group and its subgroups.
// Groups are paths like "Clients/Acme/Prod"; deeper groups and the host
// itself override what they set.
type GroupConfig struct {
	Path            string   `json:"path"`
	IdentityID      string   `json:"identityId"`
	JumpHostID      string   `json:"jumpHostId"`
	StartupCommand  string   `json:"startupCommand"`
	EnvVars         []EnvVar `json:"envVars"`
	Proxy           *Proxy   `json:"proxy,omitempty"`
	AgentForwarding bool     `json:"agentForwarding"`
	Scheme          string   `json:"scheme"`
}

// Identity bundles a username with a password and/or key for reuse.
// The password lives in the OS keyring under "identity:<id>".
type Identity struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Username    string `json:"username"`
	KeyID       string `json:"keyId"`
	HasPassword bool   `json:"hasPassword"`
}

// KeyItem is a private key kept by Remterm (file under <data>/keys/<id>).
type KeyItem struct {
	ID            string `json:"id"`
	Label         string `json:"label"`
	Type          string `json:"type"`      // ssh-ed25519, ecdsa-sha2-nistp256, ssh-rsa …
	PublicKey     string `json:"publicKey"` // authorized_keys line
	Fingerprint   string `json:"fingerprint"`
	Encrypted     bool   `json:"encrypted"`     // private key has a passphrase
	HasPassphrase bool   `json:"hasPassphrase"` // passphrase saved in the keyring
	Certificate   string `json:"certificate"`   // optional OpenSSH certificate
	Created       int64  `json:"created"`
}

type Tunnel struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Type        string `json:"type"` // "local" | "remote" | "dynamic"
	HostID      string `json:"hostId"`
	BindAddress string `json:"bindAddress"` // listen address; default 127.0.0.1 (remote: server side)
	Port        int    `json:"port"`        // listening port
	DestHost    string `json:"destHost"`
	DestPort    int    `json:"destPort"`
	AutoStart   bool   `json:"autoStart"`
}

// Workspace is a saved tab layout; Data is owned by the frontend.
type Workspace struct {
	ID   string          `json:"id"`
	Name string          `json:"name"`
	Data json.RawMessage `json:"data"`
}

// ---- generic list helpers ----

func upsert[T any](list []T, item T, id func(T) string) []T {
	for i := range list {
		if id(list[i]) == id(item) {
			list[i] = item
			return list
		}
	}
	return append(list, item)
}

func without[T any](list []T, itemID string, id func(T) string) []T {
	out := list[:0]
	for _, x := range list {
		if id(x) != itemID {
			out = append(out, x)
		}
	}
	return out
}

func find[T any](list []T, itemID string, id func(T) string) (T, bool) {
	for _, x := range list {
		if id(x) == itemID {
			return x, true
		}
	}
	var zero T
	return zero, false
}

func (s *Store) withLock(fn func(d *storeData)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(&s.data)
	return s.saveLocked()
}

func (s *Store) read(fn func(d *storeData)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(&s.data)
}

func groupPath(g GroupConfig) string { return g.Path }
func identityID(i Identity) string   { return i.ID }
func keyID(k KeyItem) string         { return k.ID }
func tunnelID(t Tunnel) string       { return t.ID }
func workspaceID(w Workspace) string { return w.ID }

// ---- effective host settings ----

// groupChain returns "A", "A/B", "A/B/C" for "A/B/C".
func groupChain(path string) []string {
	var out []string
	parts := strings.Split(strings.Trim(path, "/"), "/")
	for i := range parts {
		if p := strings.TrimSpace(strings.Join(parts[:i+1], "/")); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// effectiveHost fills settings a host leaves empty from its groups: the
// nearest group wins for single values, environment variables merge
// (parent first, then child groups, then the host).
func (a *App) effectiveHost(h Host) Host {
	var groups []GroupConfig
	a.store.read(func(d *storeData) { groups = append(groups, d.Groups...) })
	chain := groupChain(h.Group)

	env := map[string]string{}
	var order []string
	setEnv := func(vars []EnvVar) {
		for _, v := range vars {
			if v.Name == "" {
				continue
			}
			if _, ok := env[v.Name]; !ok {
				order = append(order, v.Name)
			}
			env[v.Name] = v.Value
		}
	}
	for _, path := range chain {
		if g, ok := find(groups, path, groupPath); ok {
			setEnv(g.EnvVars)
		}
	}
	setEnv(h.EnvVars)
	h.EnvVars = nil
	for _, n := range order {
		h.EnvVars = append(h.EnvVars, EnvVar{Name: n, Value: env[n]})
	}

	if h.Proxy != nil {
		h.ProxySecretKey = "proxy:" + h.ID
	}
	for i := len(chain) - 1; i >= 0; i-- {
		g, ok := find(groups, chain[i], groupPath)
		if !ok {
			continue
		}
		if h.IdentityID == "" {
			h.IdentityID = g.IdentityID
		}
		if h.JumpHostID == "" && g.JumpHostID != h.ID {
			h.JumpHostID = g.JumpHostID
		}
		if h.StartupCommand == "" {
			h.StartupCommand = g.StartupCommand
		}
		if h.Proxy == nil && g.Proxy != nil {
			p := *g.Proxy
			h.Proxy = &p
			h.ProxySecretKey = "proxy:group:" + g.Path
		}
		if h.Scheme == "" {
			h.Scheme = g.Scheme
		}
		h.AgentForwarding = h.AgentForwarding || g.AgentForwarding
	}
	return h
}

// ---- bound API: groups ----

func (a *App) ListGroups() []GroupConfig {
	var out []GroupConfig
	a.store.read(func(d *storeData) { out = append(out, d.Groups...) })
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

func (a *App) SaveGroup(g GroupConfig, proxyPassword string) (GroupConfig, error) {
	g.Path = strings.Trim(strings.TrimSpace(g.Path), "/")
	if g.Path == "" {
		return g, errors.New("group name is required")
	}
	if g.Proxy != nil {
		if g.Proxy.Host == "" {
			g.Proxy = nil
		} else if proxyPassword != "" {
			if err := setNamedSecret("proxy:group:"+g.Path, proxyPassword); err != nil {
				return g, err
			}
			g.Proxy.HasSecret = true
		}
	}
	return g, a.store.withLock(func(d *storeData) { d.Groups = upsert(d.Groups, g, groupPath) })
}

// RenameGroup moves a group (and its subgroups and hosts) to a new path.
func (a *App) RenameGroup(oldPath, newPath string) error {
	oldPath = strings.Trim(oldPath, "/")
	newPath = strings.Trim(strings.TrimSpace(newPath), "/")
	if oldPath == "" || newPath == "" {
		return errors.New("group name is required")
	}
	move := func(p string) (string, bool) {
		if p == oldPath {
			return newPath, true
		}
		if strings.HasPrefix(p, oldPath+"/") {
			return newPath + strings.TrimPrefix(p, oldPath), true
		}
		return p, false
	}
	return a.store.withLock(func(d *storeData) {
		for i := range d.Hosts {
			d.Hosts[i].Group, _ = move(d.Hosts[i].Group)
		}
		for i := range d.Groups {
			d.Groups[i].Path, _ = move(d.Groups[i].Path)
		}
	})
}

// DeleteGroup removes a group's settings; its hosts move to the parent group.
func (a *App) DeleteGroup(path string) error {
	path = strings.Trim(path, "/")
	parent := ""
	if i := strings.LastIndex(path, "/"); i >= 0 {
		parent = path[:i]
	}
	return a.store.withLock(func(d *storeData) {
		for i := range d.Hosts {
			if d.Hosts[i].Group == path {
				d.Hosts[i].Group = parent
			} else if strings.HasPrefix(d.Hosts[i].Group, path+"/") {
				d.Hosts[i].Group = parent + strings.TrimPrefix(d.Hosts[i].Group, path)
				d.Hosts[i].Group = strings.Trim(d.Hosts[i].Group, "/")
			}
		}
		d.Groups = without(d.Groups, path, groupPath)
	})
}

// ---- bound API: identities ----

func (a *App) ListIdentities() []Identity {
	var out []Identity
	a.store.read(func(d *storeData) { out = append(out, d.Identities...) })
	return out
}

func (a *App) SaveIdentity(i Identity, password string) (Identity, error) {
	i.Label = strings.TrimSpace(i.Label)
	i.Username = strings.TrimSpace(i.Username)
	if i.Username == "" {
		return i, errors.New("username is required")
	}
	if i.Label == "" {
		i.Label = i.Username
	}
	if i.ID == "" {
		i.ID = newID()
	}
	if old, ok := find(a.ListIdentities(), i.ID, identityID); ok {
		i.HasPassword = old.HasPassword
	}
	if password != "" {
		if err := setNamedSecret("identity:"+i.ID, password); err != nil {
			return i, err
		}
		i.HasPassword = true
	}
	return i, a.store.withLock(func(d *storeData) { d.Identities = upsert(d.Identities, i, identityID) })
}

func (a *App) ClearIdentityPassword(id string) error {
	deleteNamedSecret("identity:" + id)
	return a.store.withLock(func(d *storeData) {
		for i := range d.Identities {
			if d.Identities[i].ID == id {
				d.Identities[i].HasPassword = false
			}
		}
	})
}

func (a *App) DeleteIdentity(id string) error {
	deleteNamedSecret("identity:" + id)
	return a.store.withLock(func(d *storeData) {
		d.Identities = without(d.Identities, id, identityID)
		for i := range d.Hosts {
			if d.Hosts[i].IdentityID == id {
				d.Hosts[i].IdentityID = ""
			}
		}
		for i := range d.Groups {
			if d.Groups[i].IdentityID == id {
				d.Groups[i].IdentityID = ""
			}
		}
	})
}

// ---- bound API: workspaces ----

func (a *App) ListWorkspaces() []Workspace {
	var out []Workspace
	a.store.read(func(d *storeData) { out = append(out, d.Workspaces...) })
	return out
}

func (a *App) SaveWorkspace(w Workspace) (Workspace, error) {
	w.Name = strings.TrimSpace(w.Name)
	if w.Name == "" {
		return w, errors.New("workspace name is required")
	}
	if w.ID == "" {
		w.ID = newID()
	}
	return w, a.store.withLock(func(d *storeData) { d.Workspaces = upsert(d.Workspaces, w, workspaceID) })
}

func (a *App) DeleteWorkspace(id string) error {
	return a.store.withLock(func(d *storeData) { d.Workspaces = without(d.Workspaces, id, workspaceID) })
}
