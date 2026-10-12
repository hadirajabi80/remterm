package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// Host keys are verified against ~/.ssh/known_hosts, shared with OpenSSH.
var knownHostsMu sync.Mutex

func knownHostsPath() (string, error) {
	if p := os.Getenv("REMTERM_KNOWN_HOSTS"); p != "" { // tests
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	p := filepath.Join(dir, "known_hosts")
	f, err := os.OpenFile(p, os.O_CREATE|os.O_RDONLY, 0o600)
	if err != nil {
		return "", err
	}
	f.Close()
	return p, nil
}

// hostKeyCallback accepts known keys, asks before trusting a new host, and
// refuses outright when a known host presents a different key.
func (a *App) hostKeyCallback() ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		knownHostsMu.Lock()
		defer knownHostsMu.Unlock()

		path, err := knownHostsPath()
		if err != nil {
			return err
		}
		check, err := knownhosts.New(path)
		if err != nil {
			return fmt.Errorf("read known_hosts: %w", err)
		}
		err = check(hostname, remote, key)
		if err == nil {
			return nil
		}
		var ke *knownhosts.KeyError
		if !errors.As(err, &ke) {
			return err
		}
		for _, w := range ke.Want {
			if w.Key.Type() == key.Type() {
				return fmt.Errorf("HOST KEY CHANGED for %s — possible man-in-the-middle attack.\n"+
					"Server now presents %s %s.\n"+
					"If the server was reinstalled, remove line %d from %s and reconnect.",
					hostname, key.Type(), ssh.FingerprintSHA256(key), w.Line, w.Filename)
			}
		}

		answer, err := wruntime.MessageDialog(a.ctx, wruntime.MessageDialogOptions{
			Type:  wruntime.QuestionDialog,
			Title: "Verify host key",
			Message: fmt.Sprintf("The authenticity of %s can't be established.\n\n%s key fingerprint:\n%s\n\nTrust this host and continue connecting?",
				hostname, key.Type(), ssh.FingerprintSHA256(key)),
			Buttons:       []string{"Yes", "No"},
			DefaultButton: "No",
		})
		if err != nil {
			return err
		}
		if answer != "Yes" {
			return errors.New("host key not trusted")
		}

		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = fmt.Fprintln(f, knownhosts.Line([]string{knownhosts.Normalize(hostname)}, key))
		return err
	}
}

var (
	probeOnce sync.Once
	probeKey  ssh.PublicKey
)

// hostKeyAlgorithms returns the key algorithms already recorded for addr so
// the server presents a key we know, instead of a different type that would
// trigger a needless "unknown host" prompt.
func hostKeyAlgorithms(addr string) []string {
	probeOnce.Do(func() {
		pub, _, err := ed25519.GenerateKey(rand.Reader)
		if err == nil {
			probeKey, _ = ssh.NewPublicKey(pub)
		}
	})
	if probeKey == nil {
		return nil
	}

	knownHostsMu.Lock()
	defer knownHostsMu.Unlock()
	path, err := knownHostsPath()
	if err != nil {
		return nil
	}
	check, err := knownhosts.New(path)
	if err != nil {
		return nil
	}
	var ke *knownhosts.KeyError
	if err := check(addr, &net.TCPAddr{IP: net.IPv4zero}, probeKey); !errors.As(err, &ke) {
		return nil
	}

	var algos []string
	seen := map[string]bool{}
	add := func(names ...string) {
		for _, n := range names {
			if !seen[n] {
				seen[n] = true
				algos = append(algos, n)
			}
		}
	}
	for _, w := range ke.Want {
		if t := w.Key.Type(); t == ssh.KeyAlgoRSA {
			add(ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSA)
		} else {
			add(t)
		}
	}
	return algos
}

// KnownHost is one entry of ~/.ssh/known_hosts.
type KnownHost struct {
	Line        int    `json:"line"`
	Hosts       string `json:"hosts"` // comma-separated, or "(hashed)"
	KeyType     string `json:"keyType"`
	Fingerprint string `json:"fingerprint"`
	Marker      string `json:"marker"` // @cert-authority / @revoked
}

func (a *App) ListKnownHosts() ([]KnownHost, error) {
	knownHostsMu.Lock()
	defer knownHostsMu.Unlock()
	path, err := knownHostsPath()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var out []KnownHost
	for i, line := range strings.Split(string(b), "\n") {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		marker, hosts, key, _, _, err := ssh.ParseKnownHosts([]byte(t))
		if err != nil {
			continue
		}
		h := strings.Join(hosts, ", ")
		if strings.HasPrefix(h, "|1|") {
			h = "(hashed host name)"
		}
		out = append(out, KnownHost{Line: i + 1, Hosts: h, KeyType: key.Type(), Fingerprint: ssh.FingerprintSHA256(key), Marker: marker})
	}
	return out, nil
}

// RemoveKnownHost deletes one line (1-based) from known_hosts, e.g. after a
// server was reinstalled and its key changed.
func (a *App) RemoveKnownHost(line int) error {
	knownHostsMu.Lock()
	defer knownHostsMu.Unlock()
	path, err := knownHostsPath()
	if err != nil {
		return err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := strings.Split(string(b), "\n")
	if line < 1 || line > len(lines) {
		return errors.New("that entry no longer exists")
	}
	lines = append(lines[:line-1], lines[line:]...)
	return os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o600)
}
