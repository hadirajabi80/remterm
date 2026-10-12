package main

import (
	"bufio"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type sshConfigEntry struct {
	Alias, HostName, User, Port, IdentityFile, ProxyJump string
}

// set follows OpenSSH semantics: the first value for a key wins.
func (e *sshConfigEntry) set(key, val string) {
	fields := map[string]*string{
		"hostname":     &e.HostName,
		"user":         &e.User,
		"port":         &e.Port,
		"identityfile": &e.IdentityFile,
		"proxyjump":    &e.ProxyJump,
	}
	if f := fields[key]; f != nil && *f == "" {
		*f = val
	}
}

func parseSSHConfig(path string) ([]*sshConfigEntry, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var entries, current []*sshConfigEntry
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val := splitConfigLine(line)
		switch key {
		case "host":
			current = nil
			for _, pattern := range strings.Fields(val) {
				if strings.ContainsAny(pattern, "*?!") {
					continue // wildcard blocks are defaults, not hosts
				}
				e := &sshConfigEntry{Alias: pattern}
				entries = append(entries, e)
				current = append(current, e)
			}
		case "match":
			current = nil
		default:
			for _, e := range current {
				e.set(key, val)
			}
		}
	}
	return entries, sc.Err()
}

func splitConfigLine(line string) (string, string) {
	i := strings.IndexAny(line, " \t=")
	if i < 0 {
		return strings.ToLower(line), ""
	}
	key := strings.ToLower(line[:i])
	val := strings.TrimSpace(strings.TrimLeft(line[i:], " \t="))
	return key, strings.Trim(val, `"`)
}

// ImportSSHConfig adds hosts from ~/.ssh/config that are not already saved
// (matched by name) and returns how many were added.
func (a *App) ImportSSHConfig() (int, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return 0, err
	}
	entries, err := parseSSHConfig(filepath.Join(home, ".ssh", "config"))
	if errors.Is(err, os.ErrNotExist) {
		return 0, errors.New("no ~/.ssh/config file found")
	}
	if err != nil {
		return 0, err
	}

	byName := map[string]string{}
	for _, h := range a.store.Hosts() {
		byName[strings.ToLower(h.Name)] = h.ID
	}

	type pending struct {
		host Host
		jump string
	}
	var added []pending
	for _, e := range entries {
		if _, dup := byName[strings.ToLower(e.Alias)]; dup {
			continue
		}
		h := Host{
			ID:         newID(),
			Name:       e.Alias,
			Group:      "Imported",
			Address:    e.HostName,
			User:       e.User,
			AuthMethod: "auto",
			KeyPath:    e.IdentityFile,
		}
		if h.Address == "" {
			h.Address = e.Alias
		}
		h.Port, _ = strconv.Atoi(e.Port)
		if h.Port == 0 {
			h.Port = 22
		}
		byName[strings.ToLower(e.Alias)] = h.ID
		added = append(added, pending{h, e.ProxyJump})
	}

	for i, p := range added {
		h := p.host
		if j := firstJump(p.jump); j != "" {
			h.JumpHostID = byName[strings.ToLower(j)]
		}
		if err := a.store.PutHost(h); err != nil {
			return i, err
		}
	}
	return len(added), nil
}

// firstJump extracts the first hop's host from a ProxyJump value such as
// "bastion" or "admin@bastion:2222,next".
func firstJump(v string) string {
	v = strings.TrimSpace(strings.SplitN(v, ",", 2)[0])
	if strings.EqualFold(v, "none") {
		return ""
	}
	if i := strings.LastIndex(v, "@"); i >= 0 {
		v = v[i+1:]
	}
	if host, _, err := net.SplitHostPort(v); err == nil {
		return host
	}
	return v
}
