package main

import (
	"bufio"
	"errors"
	"net"
	"os"
	"path"
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

	// Wildcard blocks ("Host *", "Host *.prod !db*") are defaults, not hosts.
	type patternBlock struct {
		patterns []string
		e        *sshConfigEntry
	}
	var entries, current []*sshConfigEntry
	var blocks []patternBlock
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(stripComment(sc.Text()))
		if line == "" {
			continue
		}
		key, val := splitConfigLine(line)
		switch key {
		case "host":
			current = nil
			patterns := strings.Fields(val)
			wild := false
			for _, pattern := range patterns {
				if strings.ContainsAny(pattern, "*?!") {
					wild = true
					continue
				}
				e := &sshConfigEntry{Alias: pattern}
				entries = append(entries, e)
				current = append(current, e)
			}
			if wild {
				b := patternBlock{patterns, &sshConfigEntry{}}
				blocks = append(blocks, b)
				current = append(current, b.e)
			}
		case "match":
			current = nil
		default:
			for _, e := range current {
				e.set(key, val)
			}
		}
	}
	for _, e := range entries {
		for _, b := range blocks {
			if !hostMatches(b.patterns, e.Alias) {
				continue
			}
			for key, val := range map[string]string{"hostname": b.e.HostName, "user": b.e.User, "port": b.e.Port,
				"identityfile": b.e.IdentityFile, "proxyjump": b.e.ProxyJump} {
				if val != "" {
					e.set(key, val)
				}
			}
		}
	}
	return entries, sc.Err()
}

// hostMatches reports whether alias matches a Host line: some pattern
// matches it and no negated ("!") pattern does.
func hostMatches(patterns []string, alias string) bool {
	ok := false
	for _, p := range patterns {
		if neg := strings.HasPrefix(p, "!"); neg {
			if m, _ := path.Match(p[1:], alias); m {
				return false
			}
		} else if m, _ := path.Match(p, alias); m {
			ok = true
		}
	}
	return ok
}

// stripComment cuts a trailing comment: a '#' at the start of the line or
// after a space or tab, outside double quotes.
func stripComment(line string) string {
	quoted := false
	for i := 0; i < len(line); i++ {
		switch c := line[i]; {
		case c == '"':
			quoted = !quoted
		case c == '#' && !quoted && (i == 0 || line[i-1] == ' ' || line[i-1] == '\t'):
			return line[:i]
		}
	}
	return line
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
		if j := lastJump(p.jump); j != "" && byName[strings.ToLower(j)] != h.ID {
			h.JumpHostID = byName[strings.ToLower(j)]
		}
		if err := a.store.PutHost(h); err != nil {
			return i, err
		}
	}
	return len(added), nil
}

// lastJump extracts the hop next to the target from a ProxyJump value such
// as "bastion" or "outer,admin@bastion:2222" (OpenSSH goes through them in
// order, so the last one connects to the target).
func lastJump(v string) string {
	hops := strings.Split(v, ",")
	v = strings.TrimSpace(hops[len(hops)-1])
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
