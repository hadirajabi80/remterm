//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Remote Desktop outside Windows: the RDP control and the Windows vault are
// not available, so machines, logins and settings live here (JSON file +
// passwords in the system keychain) and a session opens in the system's RDP
// client — Microsoft's Windows App on macOS — with the server and the WALLIX
// login filled in and the password on the clipboard.
// The UI talks to it through the same RdpCall methods as the Windows engine.

type rdpMachine struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	IP           string  `json:"ip"`
	Target       string  `json:"target"`
	Group        string  `json:"group"`
	Mode         string  `json:"mode"` // "bastion" | "direct"
	CredentialID *string `json:"credentialId"`
	AutoType     string  `json:"autoType"`
	Favorite     bool    `json:"favorite"`
	LastUsed     *string `json:"lastUsed"`
	Notes        string  `json:"notes"`
}

type rdpCredential struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Username    string `json:"username"`
	HasPassword bool   `json:"hasPassword"`
}

type rdpBastion struct {
	Host                       string `json:"host"`
	Port                       int    `json:"port"`
	PrimaryUser                string `json:"primaryUser"`
	HasPassword                bool   `json:"hasPassword"`
	Authorization              string `json:"authorization"`
	LoginTemplate              string `json:"loginTemplate"`
	UseNla                     bool   `json:"useNla"`
	InteractiveLoginUsesTarget bool   `json:"interactiveLoginUsesTarget"`
	AuthLevel                  int    `json:"authLevel"`
}

type rdpFile struct {
	Machines            []rdpMachine     `json:"machines"`
	Credentials         []rdpCredential  `json:"credentials"`
	DefaultCredentialID string           `json:"defaultCredentialId"`
	Bastion             rdpBastion       `json:"bastion"`
	Settings            json.RawMessage  `json:"settings,omitempty"` // shape owned by the UI (RdpSettings)
}

type rdpEngine struct {
	app  *App
	mu   sync.Mutex
	path string
	data rdpFile
	ok   bool
}

func newRdpEngine(a *App) *rdpEngine          { return &rdpEngine{app: a} }
func (e *rdpEngine) stop()                      {}
func (e *rdpEngine) connectedSessions() int     { return 0 }
func (a *App) beforeClose(context.Context) bool { return false }

// RdpAvailable: the machine list and launching are available everywhere.
func (a *App) RdpAvailable() bool { return true }

type ClassicMenuState struct {
	Supported bool `json:"supported"`
	Enabled   bool `json:"enabled"`
}

func (a *App) ClassicMenu() ClassicMenuState { return ClassicMenuState{} }
func (a *App) SetClassicMenu(bool) error   { return errors.New("Windows-only") }
func (a *App) RestartExplorer() error      { return errors.New("Windows-only") }

func defaultRdpSettings() json.RawMessage {
	return json.RawMessage(`{"autoTypeEnabled":true,"autoFillOnConnect":false,"autoTypeDelayMs":1500,"autoTypeSequence":"{login}{TAB}{password}{ENTER}","autoTypeDetectScreen":true,"sessionUsesScreenSize":true,"colorDepth":32,"smartSizing":true,"dynamicResize":true,"redirectClipboard":true,"redirectDrives":false,"playAudioLocally":true,"windowsKeysToRemote":false,"forceUsKeyboard":false,"confirmCloseConnected":true,"autoLockMinutes":0,"sidebarWidth":290,"diagEnabled":false,"startFullscreen":false}`)
}

func (e *rdpEngine) load() error {
	if e.ok {
		return nil
	}
	dir, err := dataDir()
	if err != nil {
		return err
	}
	e.path = filepath.Join(dir, "rdp.json")
	e.data = rdpFile{Bastion: rdpBastion{Port: 3389, LoginTemplate: "{target}:{auth}:{user}", UseNla: true}, Settings: defaultRdpSettings()}
	if b, err := os.ReadFile(e.path); err == nil {
		if err := json.Unmarshal(b, &e.data); err != nil {
			_ = os.Rename(e.path, e.path+".corrupt")
		}
	}
	if len(e.data.Settings) == 0 {
		e.data.Settings = defaultRdpSettings()
	}
	e.ok = true
	return nil
}

func (e *rdpEngine) save() error {
	b, err := json.MarshalIndent(e.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := e.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, e.path)
}

func (a *App) RdpCall(method, params string) (string, error) {
	e := a.rdp
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.load(); err != nil {
		return "", err
	}
	var p map[string]json.RawMessage
	if params != "" {
		_ = json.Unmarshal([]byte(params), &p)
	}
	res, changed, err := e.call(method, p)
	if err != nil {
		return "", err
	}
	if changed {
		if err := e.save(); err != nil {
			return "", err
		}
	}
	out, err := json.Marshal(res)
	return string(out), err
}

func str(p map[string]json.RawMessage, k string) string {
	var s string
	_ = json.Unmarshal(p[k], &s)
	return s
}

// optStr distinguishes a missing/null value (nil: keep) from "" (clear).
func optStr(p map[string]json.RawMessage, k string) *string {
	raw, ok := p[k]
	if !ok || string(raw) == "null" {
		return nil
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return nil
	}
	return &s
}

func (e *rdpEngine) call(method string, p map[string]json.RawMessage) (any, bool, error) {
	d := &e.data
	switch method {
	case "status":
		return map[string]any{"ready": true, "locked": false, "needsPassword": false, "hasMaster": false, "vaultPath": e.path, "autoLockMinutes": 0}, false, nil
	case "lock", "unlock", "setMasterPassword":
		return nil, false, errors.New("the master password is part of the Windows version; here passwords are kept in the system keychain")
	case "data":
		def := d.DefaultCredentialID
		if !e.hasCredential(def) {
			def = ""
			if len(d.Credentials) > 0 {
				def = d.Credentials[0].ID
			}
		}
		b := d.Bastion
		b.HasPassword = getNamedSecret("rdp:bastion") != ""
		return map[string]any{
			"machines": nonNil(d.Machines), "credentials": nonNil(d.Credentials), "defaultCredentialId": def,
			"bastion": b, "settings": d.Settings, "hasMaster": false, "vaultPath": e.path,
			"diagEnabled": false, "ocr": false, "external": true,
		}, false, nil

	case "saveMachine":
		var m rdpMachine
		if err := json.Unmarshal(p["machine"], &m); err != nil {
			return nil, false, err
		}
		m.Name, m.IP, m.Target, m.Group = strings.TrimSpace(m.Name), strings.TrimSpace(m.IP), strings.TrimSpace(m.Target), strings.TrimSpace(m.Group)
		if m.Name == "" {
			return nil, false, errors.New("please enter a name")
		}
		if m.Mode == "direct" && m.IP == "" {
			return nil, false, errors.New("direct RDP needs an IP or host name")
		}
		if m.Mode == "" {
			m.Mode = "bastion"
		}
		if m.CredentialID != nil && *m.CredentialID == "" {
			m.CredentialID = nil
		}
		for i := range d.Machines {
			if d.Machines[i].ID == m.ID && m.ID != "" {
				m.LastUsed = d.Machines[i].LastUsed
				d.Machines[i] = m
				return m, true, nil
			}
		}
		m.ID, m.LastUsed = newID(), nil
		d.Machines = append(d.Machines, m)
		return m, true, nil
	case "deleteMachines":
		var ids []string
		_ = json.Unmarshal(p["ids"], &ids)
		kept := d.Machines[:0]
		for _, m := range d.Machines {
			if !contains(ids, m.ID) {
				kept = append(kept, m)
			}
		}
		d.Machines = kept
		return nil, true, nil
	case "renameGroup":
		from, to := str(p, "from"), strings.TrimSpace(str(p, "to"))
		if to == "Ungrouped" {
			to = ""
		}
		for i := range d.Machines {
			g := d.Machines[i].Group
			if g == "" {
				g = "Ungrouped"
			}
			if strings.EqualFold(g, from) {
				d.Machines[i].Group = to
			}
		}
		return nil, true, nil

	case "saveCredential":
		var c rdpCredential
		if err := json.Unmarshal(p["credential"], &c); err != nil {
			return nil, false, err
		}
		c.Username = strings.TrimSpace(c.Username)
		c.Name = strings.TrimSpace(c.Name)
		if c.Name == "" {
			c.Name = c.Username
		}
		if c.Name == "" {
			return nil, false, errors.New("enter a name or a login")
		}
		idx := -1
		for i := range d.Credentials {
			if d.Credentials[i].ID == c.ID && c.ID != "" {
				idx = i
			}
		}
		if idx < 0 {
			c.ID = newID()
			d.Credentials = append(d.Credentials, c)
			idx = len(d.Credentials) - 1
		}
		cur := &d.Credentials[idx]
		cur.Name, cur.Username = c.Name, c.Username
		if pw := optStr(p, "password"); pw != nil {
			if *pw == "" {
				deleteNamedSecret("rdp:cred:" + cur.ID)
			} else if err := setNamedSecret("rdp:cred:"+cur.ID, *pw); err != nil {
				return nil, false, err
			}
			cur.HasPassword = *pw != ""
		}
		if !e.hasCredential(d.DefaultCredentialID) {
			d.DefaultCredentialID = cur.ID
		}
		return *cur, true, nil
	case "deleteCredential":
		id := str(p, "id")
		kept := d.Credentials[:0]
		for _, c := range d.Credentials {
			if c.ID != id {
				kept = append(kept, c)
			}
		}
		d.Credentials = kept
		deleteNamedSecret("rdp:cred:" + id)
		for i := range d.Machines {
			if d.Machines[i].CredentialID != nil && *d.Machines[i].CredentialID == id {
				d.Machines[i].CredentialID = nil
			}
		}
		if d.DefaultCredentialID == id {
			d.DefaultCredentialID = ""
			if len(d.Credentials) > 0 {
				d.DefaultCredentialID = d.Credentials[0].ID
			}
		}
		return nil, true, nil
	case "setDefaultCredential":
		d.DefaultCredentialID = str(p, "id")
		return nil, true, nil
	case "saveBastion":
		var b rdpBastion
		if err := json.Unmarshal(p["bastion"], &b); err != nil {
			return nil, false, err
		}
		b.Host, b.PrimaryUser, b.Authorization = strings.TrimSpace(b.Host), strings.TrimSpace(b.PrimaryUser), strings.TrimSpace(b.Authorization)
		if b.Port <= 0 || b.Port > 65535 {
			b.Port = 3389
		}
		if strings.TrimSpace(b.LoginTemplate) == "" {
			b.LoginTemplate = "{target}:{auth}:{user}"
		}
		if pw := optStr(p, "password"); pw != nil {
			if *pw == "" {
				deleteNamedSecret("rdp:bastion")
			} else if err := setNamedSecret("rdp:bastion", *pw); err != nil {
				return nil, false, err
			}
		}
		d.Bastion = b
		return nil, true, nil
	case "saveSettings":
		d.Settings = p["settings"]
		return nil, true, nil

	case "importPreview":
		list, dup, skipped := parseWallix(str(p, "text"), d.Machines)
		var sample []string
		for i := 0; i < len(list) && i < 6; i++ {
			sample = append(sample, list[i].Name)
		}
		return map[string]any{"count": len(list), "duplicates": dup, "skipped": skipped, "sample": nonNil(sample)}, false, nil
	case "import":
		list, _, _ := parseWallix(str(p, "text"), d.Machines)
		group, cred := strings.TrimSpace(str(p, "group")), str(p, "credentialId")
		for _, m := range list {
			if group != "" {
				m.Group = group
			}
			if cred != "" {
				c := cred
				m.CredentialID = &c
			}
			d.Machines = append(d.Machines, m)
		}
		return map[string]any{"imported": len(list)}, len(list) > 0, nil

	case "launch":
		return e.launch(p)
	case "openDiag", "bounds", "focus", "clip", "dock", "fill", "fullscreen", "popout", "reconnect", "disconnect", "close":
		return nil, false, nil
	case "connectedCount":
		return 0, false, nil
	case "snapshot":
		return "", false, nil
	case "open":
		return nil, false, errors.New("sessions inside tabs need Windows — Remterm opens them in your RDP client here")
	}
	return nil, false, fmt.Errorf("unknown method %s", method)
}

func (e *rdpEngine) hasCredential(id string) bool {
	for _, c := range e.data.Credentials {
		if c.ID == id {
			return true
		}
	}
	return false
}

// resolveCredential: the machine's own login, none, or the default one.
func (e *rdpEngine) resolveCredential(m rdpMachine) (rdpCredential, bool) {
	if m.CredentialID != nil && *m.CredentialID == "none" {
		return rdpCredential{}, false
	}
	want := e.data.DefaultCredentialID
	if m.CredentialID != nil {
		want = *m.CredentialID
	}
	for _, c := range e.data.Credentials {
		if c.ID == want {
			return c, true
		}
	}
	if m.CredentialID == nil && len(e.data.Credentials) > 0 {
		return e.data.Credentials[0], true
	}
	return rdpCredential{}, false
}

// bastionLogin builds the WALLIX selector-bypass login, e.g. Interactive@NFCore-1.2.3.4:RDP:Auth:user.
func bastionLogin(b rdpBastion, target string) string {
	if strings.TrimSpace(target) == "" {
		return b.PrimaryUser
	}
	tpl := b.LoginTemplate
	if strings.TrimSpace(tpl) == "" {
		tpl = "{target}:{auth}:{user}"
	}
	s := strings.NewReplacer("{target}", strings.TrimSpace(target), "{auth}", strings.TrimSpace(b.Authorization), "{user}", strings.TrimSpace(b.PrimaryUser)).Replace(tpl)
	for strings.Contains(s, "::") {
		s = strings.ReplaceAll(s, "::", ":")
	}
	return strings.Trim(s, ":")
}

// launch writes a .rdp file and opens it with the system's RDP client.
func (e *rdpEngine) launch(p map[string]json.RawMessage) (any, bool, error) {
	d := &e.data
	var m rdpMachine
	switch {
	case string(p["selector"]) == "true":
		m = rdpMachine{Name: "WALLIX list", Mode: "bastion"}
	case str(p, "machineId") != "":
		id := str(p, "machineId")
		found := false
		for _, x := range d.Machines {
			if x.ID == id {
				m, found = x, true
			}
		}
		if !found {
			return nil, false, errors.New("that machine was deleted")
		}
	default:
		if err := json.Unmarshal(p["machine"], &m); err != nil {
			return nil, false, err
		}
		if m.Mode == "" {
			m.Mode = "direct"
		}
	}

	var settings struct {
		SessionUsesScreenSize bool `json:"sessionUsesScreenSize"`
		RedirectClipboard     bool `json:"redirectClipboard"`
		RedirectDrives        bool `json:"redirectDrives"`
		PlayAudioLocally      bool `json:"playAudioLocally"`
		WindowsKeysToRemote   bool `json:"windowsKeysToRemote"`
		ColorDepth            int  `json:"colorDepth"`
	}
	_ = json.Unmarshal(d.Settings, &settings)

	var host, user, password, which string
	port := 3389
	if m.Mode == "direct" {
		host = m.IP
		if i := strings.LastIndex(host, ":"); i > 0 && strings.Count(host, ":") == 1 {
			fmt.Sscanf(host[i+1:], "%d", &port)
			host = host[:i]
		}
		if c, ok := e.resolveCredential(m); ok {
			user, password, which = c.Username, getNamedSecret("rdp:cred:"+c.ID), "login"
		}
	} else {
		if strings.TrimSpace(d.Bastion.Host) == "" {
			return nil, false, errors.New("BASTION: Enter the WALLIX bastion address first (Remote Desktop settings).")
		}
		host, port = d.Bastion.Host, d.Bastion.Port
		user, password, which = bastionLogin(d.Bastion, m.Target), getNamedSecret("rdp:bastion"), "bastion"
	}
	if host == "" {
		return nil, false, errors.New("this machine has no address")
	}

	b2i := map[bool]int{true: 1, false: 0}
	screen := 1
	if settings.SessionUsesScreenSize {
		screen = 2
	}
	audio := 2
	if settings.PlayAudioLocally {
		audio = 0
	}
	keyHook := 2
	if settings.WindowsKeysToRemote {
		keyHook = 1
	}
	depth := settings.ColorDepth
	if depth == 0 {
		depth = 32
	}
	lines := []string{
		fmt.Sprintf("full address:s:%s:%d", host, port),
		"username:s:" + user,
		fmt.Sprintf("screen mode id:i:%d", screen),
		fmt.Sprintf("session bpp:i:%d", depth),
		fmt.Sprintf("redirectclipboard:i:%d", b2i[settings.RedirectClipboard]),
		fmt.Sprintf("audiomode:i:%d", audio),
		fmt.Sprintf("keyboardhook:i:%d", keyHook),
		fmt.Sprintf("authentication level:i:%d", d.Bastion.AuthLevel),
		fmt.Sprintf("enablecredsspsupport:i:%d", b2i[m.Mode == "direct" || d.Bastion.UseNla]),
		"smart sizing:i:1",
		"dynamic resolution:i:1",
		"autoreconnection enabled:i:1",
	}
	if settings.RedirectDrives {
		lines = append(lines, "drivestoredirect:s:*")
	}
	safe := regexp.MustCompile(`[^\w.-]+`).ReplaceAllString(m.Name, "_")
	dir := filepath.Join(os.TempDir(), "remterm-rdp")
	_ = os.MkdirAll(dir, 0o700)
	file := filepath.Join(dir, safe+".rdp")
	if err := os.WriteFile(file, []byte(strings.Join(lines, "\r\n")+"\r\n"), 0o600); err != nil {
		return nil, false, err
	}

	cmd := exec.Command("xdg-open", file)
	if runtime.GOOS == "darwin" {
		cmd = exec.Command("open", file)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		msg := strings.TrimSpace(string(out))
		if runtime.GOOS == "darwin" {
			return nil, false, fmt.Errorf("could not open the Remote Desktop client (%s). Install Microsoft's “Windows App” from the App Store, then try again", msg)
		}
		return nil, false, fmt.Errorf("could not open an RDP client (%s)", msg)
	}

	message := fmt.Sprintf("Opened %s in your Remote Desktop client", m.Name)
	if password != "" && e.app.ctx != nil {
		_ = wruntime.ClipboardSetText(e.app.ctx, password)
		message += fmt.Sprintf(" — the %s password is on the clipboard (⌘V)", which)
		go func() { // don't leave it there
			time.Sleep(45 * time.Second)
			if cur, err := wruntime.ClipboardGetText(e.app.ctx); err == nil && cur == password {
				_ = wruntime.ClipboardSetText(e.app.ctx, "")
			}
		}()
	}
	changed := false
	if m.ID != "" {
		now := time.Now().Format(time.RFC3339)
		for i := range d.Machines {
			if d.Machines[i].ID == m.ID {
				d.Machines[i].LastUsed = &now
				changed = true
			}
		}
	}
	return map[string]any{"message": message}, changed, nil
}

var (
	wallixTarget = regexp.MustCompile(`([^\s@]+)@([^\s:@]+):([A-Za-z0-9_]+)`)
	wallixIP     = regexp.MustCompile(`^(.+?)-(\d{1,3}(?:\.\d{1,3}){3})$`)
)

// parseWallix turns a pasted WALLIX target list into machines (same rules as the Windows engine).
func parseWallix(text string, existing []rdpMachine) (list []rdpMachine, dup, skipped int) {
	have := map[string]bool{}
	for _, m := range existing {
		have[strings.ToLower(m.Target)] = true
	}
	for _, mt := range wallixTarget.FindAllStringSubmatch(text, -1) {
		target, device, proto := mt[0], mt[2], mt[3]
		if !strings.EqualFold(proto, "RDP") {
			skipped++
			continue
		}
		if have[strings.ToLower(target)] {
			dup++
			continue
		}
		have[strings.ToLower(target)] = true
		name, ip := device, ""
		if im := wallixIP.FindStringSubmatch(device); im != nil {
			name, ip = im[1], im[2]
		}
		list = append(list, rdpMachine{ID: newID(), Name: name, IP: ip, Target: target, Mode: "bastion", AutoType: "auto", Group: guessGroup(name)})
	}
	return
}

func guessGroup(name string) string {
	if strings.HasPrefix(strings.ToUpper(name), "PTN") {
		return "PTN"
	}
	for _, k := range []string{"IRPT", "CSDI", "NF", "RC"} {
		if strings.HasPrefix(name, k) {
			return k
		}
	}
	caps := regexp.MustCompile(`^[A-Z]+`).FindString(name)
	if len(caps) > 0 && len(caps) < len(name) && name[len(caps)] >= 'a' && name[len(caps)] <= 'z' {
		caps = caps[:len(caps)-1]
	}
	if len(caps) >= 2 {
		return caps
	}
	if w := regexp.MustCompile(`^[A-Z][a-z]+`).FindString(name); w != "" {
		return w
	}
	return "Other"
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
