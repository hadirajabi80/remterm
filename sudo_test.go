package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/zalando/go-keyring"
	"golang.org/x/crypto/ssh"
)

type sudoTestWriter struct{ writes chan string }

func (w *sudoTestWriter) Write(b []byte) (int, error) {
	w.writes <- string(b)
	return len(b), nil
}

func sudoTestSession(t *testing.T) (*Session, *sudoTestWriter) {
	t.Helper()
	w := &sudoTestWriter{writes: make(chan string, 16)}
	s := &Session{stdin: w, done: make(chan struct{}), sudo: newSudoResponder("alice", "sudo-secret")}
	t.Cleanup(func() { close(s.done); s.stopSudo() })
	return s, w
}

func expectSudoWrite(t *testing.T, w *sudoTestWriter, want string) {
	t.Helper()
	select {
	case got := <-w.writes:
		if got != want {
			t.Fatalf("write = %q, want %q", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("missing terminal input")
	}
}

func expectNoSudoWrite(t *testing.T, w *sudoTestWriter) {
	t.Helper()
	select {
	case got := <-w.writes:
		t.Fatalf("unexpected terminal input: %q", got)
	case <-time.After(2 * sudoPromptDelay):
	}
}

func TestSudoSplitPromptAndRetry(t *testing.T) {
	s, w := sudoTestSession(t)
	if err := s.writeInput("sudo apt update\r"); err != nil {
		t.Fatal(err)
	}
	expectSudoWrite(t, w, "sudo apt update\r")
	var output sudoOutput
	for _, fragment := range []string{"\x1b[3", "1m[sud", "o] password for ali", "ce:\x1b[0m "} {
		s.observeSudo(&output, []byte(fragment))
	}
	expectSudoWrite(t, w, "sudo-secret\n")
	s.observeSudo(&output, []byte("\r\nSorry, try again.\r\n[sudo] password for alice: "))
	expectNoSudoWrite(t, w)
	// A manual password and its retry do not re-arm automation.
	_ = s.writeInput("manual-password\r")
	expectSudoWrite(t, w, "manual-password\r")
	s.observeSudo(&output, []byte("\r\n[sudo] password for alice: "))
	expectNoSudoWrite(t, w)
	// A later sudo command gets a fresh, single attempt.
	_ = s.writeInput("sudo id\n")
	expectSudoWrite(t, w, "sudo id\n")
	s.observeSudo(&output, []byte("[sudo] password for alice: "))
	expectSudoWrite(t, w, "sudo-secret\n")
}

func TestSudoPromptBoundaries(t *testing.T) {
	for _, prompt := range []string{
		"Password: ", "[sudo] password for root: ",
		"alice@nested-server's password: ", "prefix [sudo] password for alice: ",
		"[sudo] password for alice: \r\n", "[sudo] password for alice: more output",
		"\x1b]0;[sudo] password for alice: \a", strings.Repeat("x", 600) + "[sudo] password for alice: ",
	} {
		t.Run(prompt, func(t *testing.T) {
			s, w := sudoTestSession(t)
			_ = s.writeInput("sudo id\r")
			expectSudoWrite(t, w, "sudo id\r")
			var output sudoOutput
			s.observeSudo(&output, []byte(prompt))
			expectNoSudoWrite(t, w)
		})
	}
}

func TestSudoPendingReplyCancellation(t *testing.T) {
	for _, cancel := range []string{"manual", "output", "disconnect", "expired"} {
		t.Run(cancel, func(t *testing.T) {
			s, w := sudoTestSession(t)
			_ = s.writeInput("sudo id\r")
			expectSudoWrite(t, w, "sudo id\r")
			var output sudoOutput
			s.observeSudo(&output, []byte("[sudo] password for alice: "))
			switch cancel {
			case "manual":
				_ = s.writeInput("m")
				expectSudoWrite(t, w, "m")
			case "output":
				s.observeSudo(&output, []byte("\r\n"))
			case "disconnect":
				s.stopSudo()
			case "expired":
				s.sudo.mu.Lock()
				s.sudo.armedUntil = time.Now().Add(-time.Second)
				s.sudo.mu.Unlock()
			}
			expectNoSudoWrite(t, w)
		})
	}
}

func TestSudoCommandTracking(t *testing.T) {
	for _, tc := range []struct {
		input string
		armed bool
	}{
		{"sudo id\r", true}, {"sudo id\r\n", true},
		{"cd /tmp && /usr/bin/sudo id\n", true},
		{"\x1b[200~sudo id\x1b[201~\r", true},
		{"sudx\x7fo id\r", true}, {"wrong\x15sudo id\r", true},
		{"sudo id", false}, {"sudo id\x03\r", false},
		{"sudo id\x1b[D\r", false}, {"sudo\tid\r", false},
		{"echo hello\r", false}, {"ssh nested\r", false},
	} {
		t.Run(tc.input, func(t *testing.T) {
			r := newSudoResponder("alice", "secret")
			r.onInput(tc.input)
			if got := time.Now().Before(r.armedUntil); got != tc.armed {
				t.Fatalf("armed = %v, want %v", got, tc.armed)
			}
		})
	}
}

func TestSudoDisabledOrMissingCredentials(t *testing.T) {
	for _, password := range []string{"", "bad\ncommand", "bad\rcommand", "bad\x1bcommand"} {
		if newSudoResponder("alice", password) != nil {
			t.Fatalf("automation allowed password %q", password)
		}
	}
	s := &Session{stdin: io.Discard, done: make(chan struct{})}
	var output sudoOutput
	s.observeSudo(&output, []byte("[sudo] password for alice: "))
	if err := s.writeInput("sudo id\r"); err != nil {
		t.Fatal(err)
	}
}

func TestSudoCredentialsLifecycle(t *testing.T) {
	keyring.MockInit()
	t.Cleanup(keyring.MockInit)
	srv := startTestServer(t)
	a := newTestApp(t, srv)
	h, err := a.SaveHostWithSudo(Host{Address: "example.test", AutoSudo: true}, "", "", "private-sudo-password", false)
	if err != nil || !h.HasSudoSecret {
		t.Fatalf("save: %+v %v", h, err)
	}
	if got := getNamedSecret("sudo:" + h.ID); got != "private-sudo-password" {
		t.Fatalf("sudo secret = %q", got)
	}
	raw, _ := json.Marshal(a.store.data)
	if bytes.Contains(raw, []byte("private-sudo-password")) {
		t.Fatal("password leaked into host JSON")
	}
	h, err = a.SaveHost(h, "", "") // unrelated edits retain the credential
	if err != nil || !h.HasSudoSecret {
		t.Fatalf("preserve: %+v %v", h, err)
	}
	duplicate := h
	duplicate.ID = ""
	copy, err := a.SaveHost(duplicate, "", "")
	if err != nil || copy.HasSudoSecret {
		t.Fatalf("duplicate claimed another host's secret: %+v %v", copy, err)
	}
	h, err = a.SaveHostWithSudo(h, "", "", "", true)
	if err != nil || h.HasSudoSecret || getNamedSecret("sudo:"+h.ID) != "" {
		t.Fatalf("forget: %+v %v", h, err)
	}
	h, err = a.SaveHostWithSudo(h, "", "", "replacement", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.DeleteHost(h.ID); err != nil || getNamedSecret("sudo:"+h.ID) != "" {
		t.Fatalf("delete left sudo credential: %v", err)
	}
	keyring.MockInitWithError(errors.New("locked"))
	if _, err := a.SaveHostWithSudo(copy, "", "", "new-password", false); err == nil {
		t.Fatal("credential-store failure ignored")
	}
}

func TestSudoSSHCredentialSelection(t *testing.T) {
	keyring.MockInit()
	t.Cleanup(keyring.MockInit)
	srv := startTestServer(t)
	a := newTestApp(t, srv)
	host, port := splitAddr(t, srv.addr)
	h := Host{Address: host, Port: port, User: "u", AuthMethod: "password"}
	c, err := a.connectHost(h, "pw", nil)
	if err != nil {
		t.Fatal(err)
	}
	if c.loginPassword != "pw" {
		t.Fatal("SSH login password unavailable for sudo")
	}
	c.Close()
	key, err := a.GenerateKey(GenerateKeyRequest{Label: "sudo-test", Type: "ed25519"})
	if err != nil {
		t.Fatal(err)
	}
	pub, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(key.PublicKey))
	srv.allowKey(pub)
	h.KeyID, h.AuthMethod = key.ID, "auto"
	c, err = a.connectHost(h, "key-passphrase-never-for-sudo", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if c.loginPassword != "" {
		t.Fatal("a key login exposed its passphrase as a sudo password")
	}
}

func TestSudoSSHFlow(t *testing.T) {
	for _, mode := range []string{"login-password", "separate-password", "key-login", "disabled", "missing-saved-secret", "startup-command", "named-password"} {
		t.Run(mode, func(t *testing.T) {
			keyring.MockInit()
			t.Cleanup(keyring.MockInit)
			srv := startTestServer(t)
			a := newTestApp(t, srv)
			host, port := splitAddr(t, srv.addr)
			h := Host{ID: "sudo-host", Address: host, Port: port, User: "u", AuthMethod: "password", AutoSudo: mode != "disabled"}
			wantPassword := "pw\n"
			if mode == "named-password" {
				item, err := a.SavePassword(PasswordItem{Title: "Production sudo"}, "named-sudo-secret")
				if err != nil {
					t.Fatal(err)
				}
				h.SudoPasswordID = item.ID
				wantPassword = "named-sudo-secret\n"
			}
			if mode == "separate-password" || mode == "key-login" {
				h.HasSudoSecret = true
				wantPassword = "sudo-only-secret\n"
				if err := setNamedSecret("sudo:"+h.ID, "sudo-only-secret"); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "key-login" {
				key, err := a.GenerateKey(GenerateKeyRequest{Label: "sudo", Type: "ed25519"})
				if err != nil {
					t.Fatal(err)
				}
				pub, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(key.PublicKey))
				srv.allowKey(pub)
				h.KeyID, h.AuthMethod = key.ID, "key"
			}
			if mode == "missing-saved-secret" {
				h.HasSudoSecret = true
			}
			if mode == "startup-command" {
				h.StartupCommand = "sudo id"
			}
			if err := a.store.PutHost(h); err != nil {
				t.Fatal(err)
			}
			lines := make(chan string, 4)
			srv.mu.Lock()
			srv.shell = func(ch ssh.Channel) {
				defer ch.Close()
				r := bufio.NewReader(ch)
				for i := 0; i < 3; i++ {
					line, err := r.ReadString('\n')
					if err != nil {
						return
					}
					lines <- line
					// Prompts go through SSH extended data (stderr), split into
					// several packets. The password is consumed without echo.
					_, _ = io.WriteString(ch.Stderr(), "\r\n\x1b[33m[sudo] pass")
					_, _ = io.WriteString(ch.Stderr(), "word for u:\x1b[0m ")
				}
			}
			srv.mu.Unlock()
			_, err := a.Connect(ConnectRequest{SessionID: "sudo-session", HostID: h.ID, Password: "pw"})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { a.Disconnect("sudo-session") })
			s := a.session("sudo-session")
			if h.StartupCommand == "" {
				if err := a.Write(s.id, "sudo id\n"); err != nil {
					t.Fatal(err)
				}
			}
			expectSudoWrite(t, &sudoTestWriter{lines}, "sudo id\n")
			if mode == "disabled" || mode == "missing-saved-secret" {
				expectNoSudoWrite(t, &sudoTestWriter{lines})
				return
			}
			expectSudoWrite(t, &sudoTestWriter{lines}, wantPassword)
			expectNoSudoWrite(t, &sudoTestWriter{lines}) // no automatic retry
			a.Disconnect(s.id)
			log, err := os.ReadFile(a.logs.file(s.log.id))
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(log, []byte(strings.TrimSpace(wantPassword))) {
				t.Fatal("automatic password appeared in the session log")
			}
		})
	}
}
