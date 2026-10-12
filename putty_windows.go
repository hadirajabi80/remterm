//go:build windows

package main

import (
	"errors"
	"net/url"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// ImportPuTTY adds PuTTY's saved sessions (SSH, Telnet, Serial) as hosts in
// the "PuTTY" group. PuTTY .ppk keys are not converted; link a keychain key
// (or import it after exporting from PuTTYgen as OpenSSH) instead.
func (a *App) ImportPuTTY() (int, error) {
	root, err := registry.OpenKey(registry.CURRENT_USER, `Software\SimonTatham\PuTTY\Sessions`, registry.READ)
	if err != nil {
		return 0, errors.New("no PuTTY sessions found on this PC")
	}
	defer root.Close()
	names, err := root.ReadSubKeyNames(-1)
	if err != nil {
		return 0, err
	}
	existing := map[string]bool{}
	for _, h := range a.store.Hosts() {
		existing[strings.ToLower(h.Name)] = true
	}
	added := 0
	for _, enc := range names {
		name, _ := url.QueryUnescape(enc)
		if name == "Default Settings" || existing[strings.ToLower(name)] {
			continue
		}
		k, err := registry.OpenKey(root, enc, registry.READ)
		if err != nil {
			continue
		}
		str := func(v string) string { s, _, _ := k.GetStringValue(v); return s }
		num := func(v string) int { n, _, _ := k.GetIntegerValue(v); return int(n) }
		h := Host{ID: newID(), Name: name, Group: "PuTTY", AuthMethod: "auto", Address: str("HostName"), Port: num("PortNumber"), User: str("UserName")}
		if i := strings.LastIndex(h.Address, "@"); i >= 0 { // "user@host" in the host field
			if h.User == "" {
				h.User = h.Address[:i]
			}
			h.Address = h.Address[i+1:]
		}
		switch str("Protocol") {
		case "telnet":
			h.Protocol = "telnet"
		case "serial":
			h.Protocol = "serial"
			h.Serial = &SerialConfig{Port: str("SerialLine"), Baud: num("SerialSpeed"), DataBits: num("SerialDataBits")}
			if h.Address == "" {
				h.Address = h.Serial.Port
			}
		case "ssh", "":
		default:
			k.Close()
			continue // raw/rlogin are not supported
		}
		k.Close()
		if h.Address == "" {
			continue
		}
		if h.Port == 0 {
			h.Port = 22
		}
		if err := a.store.PutHost(h); err != nil {
			return added, err
		}
		added++
	}
	return added, nil
}
