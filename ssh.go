package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// Session is one interactive terminal: a remote SSH shell or a local
// process on a pseudo-console. Transport details live in resize/closeFn.
type Session struct {
	id      string
	client  *ssh.Client // nil for local shells; used for keepalive
	stdin   io.Writer
	resize  func(cols, rows int) error
	closeFn func()
	log     *sessionLog // nil when logging is off
	done    chan struct{}
	once    sync.Once
}

// ConnectRequest opens a shell either for a saved host (HostID) or an
// ad-hoc "user@host:port" spec. The frontend picks SessionID up front so it
// can subscribe to output events before the first byte arrives.
type ConnectRequest struct {
	SessionID    string `json:"sessionId"`
	HostID       string `json:"hostId"`
	Spec         string `json:"spec"`
	Password     string `json:"password"`
	SavePassword bool   `json:"savePassword"`
	Cols         int    `json:"cols"`
	Rows         int    `json:"rows"`
}

// Errors prefixed with these markers make the UI prompt for credentials.
const (
	errAuthFailed         = "AUTH_FAILED"
	errPassphraseRequired = "PASSPHRASE_REQUIRED"
)

// ConnectResult tells the UI which saved host the session belongs to, so
// quick-connect tabs reconnect through the saved host from then on.
type ConnectResult struct {
	HostID string `json:"hostId"`
	Saved  bool   `json:"saved"` // a new host was added to the list
}

func (a *App) Connect(req ConnectRequest) (ConnectResult, error) {
	if req.SessionID == "" {
		return ConnectResult{}, errors.New("missing session id")
	}

	var h Host
	if req.HostID != "" {
		var ok bool
		if h, ok = a.store.Host(req.HostID); !ok {
			return ConnectResult{}, errors.New("host not found (was it deleted?)")
		}
	} else {
		var err error
		if h, err = parseSpec(req.Spec); err != nil {
			return ConnectResult{}, err
		}
		// Quick connect to a server that is already saved uses its settings
		// (key, jump host, saved password).
		if saved, ok := a.findHost(h); ok {
			h = saved
		}
	}

	switch h.Protocol {
	case "telnet":
		return ConnectResult{HostID: h.ID}, a.openTelnet(req, h)
	case "serial":
		return ConnectResult{HostID: h.ID}, a.openSerial(req, h)
	}

	conn, err := a.connectHost(h, req.Password, nil)
	if err != nil {
		return ConnectResult{}, err
	}

	cols, rows := clamp(req.Cols, 20, 1000, 80), clamp(req.Rows, 5, 500, 24)
	sess, stdin, stdout, stderr, err := openShell(conn, cols, rows)
	if err != nil {
		conn.Close()
		return ConnectResult{}, err
	}

	res := a.rememberConnection(h, req.Password, req.SavePassword)

	s := &Session{
		id:     req.SessionID,
		client: conn.client,
		stdin:  stdin,
		resize: func(cols, rows int) error { return sess.WindowChange(rows, cols) },
		closeFn: func() {
			sess.Close()
			conn.Close()
		},
		done: make(chan struct{}),
	}
	a.registerSession(s, "ssh:"+res.HostID, conn.host.Name)

	go a.pump(s, stdout)
	go a.pump(s, stderr)
	go func() {
		err := sess.Wait()
		var exitErr *ssh.ExitError
		switch {
		case err == nil:
			a.closeSession(s, "Session ended", false, 0)
		case errors.As(err, &exitErr):
			a.closeSession(s, fmt.Sprintf("Session ended (exit code %d)", exitErr.ExitStatus()), false, exitErr.ExitStatus())
		default:
			a.closeSession(s, "Connection lost", true, -1)
		}
	}()
	go a.keepalive(s)

	if cmd := strings.TrimSpace(conn.host.StartupCommand); cmd != "" {
		_, _ = io.WriteString(stdin, cmd+"\n")
	}
	return res, nil
}

// registerSession makes a session reachable by id and starts its log.
func (a *App) registerSession(s *Session, hostKey, title string) {
	s.log = a.logs.start(hostKey, title)
	a.mu.Lock()
	a.sessions[s.id] = s
	a.mu.Unlock()
}

func openShell(conn *sshConn, cols, rows int) (*ssh.Session, io.WriteCloser, io.Reader, io.Reader, error) {
	sess, err := conn.client.NewSession()
	if err != nil {
		return nil, nil, nil, nil, err
	}
	fail := func(err error) (*ssh.Session, io.WriteCloser, io.Reader, io.Reader, error) {
		sess.Close()
		return nil, nil, nil, nil, err
	}
	if conn.forward != nil {
		if err := agent.ForwardToAgent(conn.client, conn.forward); err == nil {
			_ = agent.RequestAgentForwarding(sess)
		}
	}
	// Like OpenSSH SendEnv: the server drops names its AcceptEnv doesn't allow.
	for _, v := range conn.host.EnvVars {
		_ = sess.Setenv(v.Name, v.Value)
	}
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		return fail(fmt.Errorf("request pty: %w", err))
	}
	_ = sess.Setenv("COLORTERM", "truecolor") // most servers reject this; harmless
	stdin, err := sess.StdinPipe()
	if err != nil {
		return fail(err)
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		return fail(err)
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		return fail(err)
	}
	if err := sess.Shell(); err != nil {
		return fail(fmt.Errorf("start shell: %w", err))
	}
	return sess, stdin, stdout, stderr, nil
}

func (a *App) Write(id, data string) error {
	s := a.session(id)
	if s == nil {
		return errors.New("session closed")
	}
	_, err := io.WriteString(s.stdin, data)
	return err
}

func (a *App) Resize(id string, cols, rows int) error {
	s := a.session(id)
	if s == nil {
		return nil
	}
	return s.resize(clamp(cols, 20, 1000, 80), clamp(rows, 5, 500, 24))
}

func (a *App) Disconnect(id string) {
	if s := a.session(id); s != nil {
		a.closeSession(s, "Disconnected", false, -1)
	}
}

func (a *App) session(id string) *Session {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[id]
}

// closeSession tears a session down once and tells the UI why. lost means
// the connection dropped (the UI reconnects); exitCode is the remote/local
// process exit status, or -1 when there is none.
func (a *App) closeSession(s *Session, reason string, lost bool, exitCode int) {
	s.once.Do(func() {
		close(s.done)
		s.closeFn()
		s.log.finish()
		a.mu.Lock()
		delete(a.sessions, s.id)
		a.mu.Unlock()
		a.emit("term:closed", s.id, reason, lost, exitCode)
	})
}

// pump streams remote output to the UI. Bytes are base64-encoded so that
// multi-byte UTF-8 sequences split across reads survive the JSON bridge;
// xterm.js reassembles them.
func (a *App) pump(s *Session, r io.Reader) {
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			a.emit("term:data", s.id, base64.StdEncoding.EncodeToString(buf[:n]))
			s.log.write(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

// keepalive detects dead connections (sleep, Wi-Fi drop) and reports
// round-trip latency to the status bar.
func (a *App) keepalive(s *Session) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		start := time.Now()
		res := make(chan error, 1)
		go func() {
			_, _, err := s.client.SendRequest("keepalive@openssh.com", true, nil)
			res <- err
		}()
		select {
		case <-s.done:
			return
		case err := <-res:
			if err != nil {
				a.closeSession(s, "Connection lost", true, -1)
				return
			}
			a.emit("term:latency", s.id, time.Since(start).Milliseconds())
		case <-time.After(20 * time.Second):
			a.closeSession(s, "Connection timed out", true, -1)
			return
		}
		select {
		case <-s.done:
			return
		case <-ticker.C:
		}
	}
}

// ---- helpers ----

func parseSpec(spec string) (Host, error) {
	spec = strings.TrimSpace(spec)
	spec = strings.TrimSpace(strings.TrimPrefix(spec, "ssh "))
	if spec == "" {
		return Host{}, errors.New("enter a host like user@server:22")
	}
	h := Host{Name: spec, AuthMethod: "auto", Port: 22}
	if i := strings.LastIndex(spec, "@"); i >= 0 {
		h.User, spec = spec[:i], spec[i+1:]
	}
	if host, port, err := net.SplitHostPort(spec); err == nil {
		p, err := strconv.Atoi(port)
		if err != nil || p <= 0 || p > 65535 {
			return Host{}, fmt.Errorf("invalid port %q", port)
		}
		h.Address, h.Port = host, p
	} else {
		h.Address = strings.Trim(spec, "[]")
	}
	if h.Address == "" {
		return Host{}, errors.New("missing host name")
	}
	return h, nil
}

func hostAddr(h Host) string {
	port := h.Port
	if port == 0 {
		port = 22
	}
	return net.JoinHostPort(h.Address, strconv.Itoa(port))
}

func defaultUser() string {
	if u, err := user.Current(); err == nil {
		name := u.Username
		if i := strings.LastIndexAny(name, `\/`); i >= 0 {
			name = name[i+1:]
		}
		if name != "" {
			return name
		}
	}
	return "root"
}

func defaultKeyPaths() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var out []string
	for _, name := range []string{"id_ed25519", "id_ecdsa", "id_rsa"} {
		p := filepath.Join(home, ".ssh", name)
		if _, err := os.Stat(p); err == nil {
			out = append(out, p)
		}
	}
	return out
}

func expandPath(p string) string {
	home, _ := os.UserHomeDir()
	p = strings.ReplaceAll(strings.TrimSpace(p), "%d", home)
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		return filepath.Join(home, p[2:])
	}
	return p
}

func clamp(v, lo, hi, def int) int {
	if v <= 0 {
		return def
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func closeAll(clients ...*ssh.Client) {
	for _, c := range clients {
		if c != nil {
			c.Close()
		}
	}
}
