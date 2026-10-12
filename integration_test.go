package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
	"golang.org/x/net/proxy"
)

// ---- a tiny SSH server: password + public key auth, SFTP, direct-tcpip ----

type testServer struct {
	addr     string
	hostKey  ssh.Signer
	mu       sync.Mutex
	authKeys map[string]bool // marshalled public keys
	sftpRoot string
}

func startTestServer(t *testing.T) *testServer {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	hk, _ := ssh.NewSignerFromKey(priv)
	s := &testServer{hostKey: hk, authKeys: map[string]bool{}, sftpRoot: t.TempDir()}
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if c.User() == "u" && string(pw) == "pw" {
				return nil, nil
			}
			return nil, fmt.Errorf("bad password")
		},
		PublicKeyCallback: func(c ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.authKeys[string(k.Marshal())] {
				return nil, nil
			}
			return nil, fmt.Errorf("unknown key")
		},
	}
	cfg.AddHostKey(hk)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	s.addr = ln.Addr().String()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(c, cfg)
		}
	}()
	return s
}

func (s *testServer) allowKey(k ssh.PublicKey) {
	s.mu.Lock()
	s.authKeys[string(k.Marshal())] = true
	s.mu.Unlock()
}

func (s *testServer) serve(c net.Conn, cfg *ssh.ServerConfig) {
	_, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		switch nc.ChannelType() {
		case "direct-tcpip":
			var p struct {
				Host     string
				Port     uint32
				OrigHost string
				OrigPort uint32
			}
			_ = ssh.Unmarshal(nc.ExtraData(), &p)
			target, err := net.Dial("tcp", net.JoinHostPort(p.Host, strconv.Itoa(int(p.Port))))
			if err != nil {
				_ = nc.Reject(ssh.ConnectionFailed, err.Error())
				continue
			}
			ch, rq, _ := nc.Accept()
			go ssh.DiscardRequests(rq)
			go func() {
				go func() { _, _ = io.Copy(ch, target); ch.Close() }()
				_, _ = io.Copy(target, ch)
				target.Close()
			}()
		case "session":
			ch, rq, _ := nc.Accept()
			go func() {
				for r := range rq {
					switch r.Type {
					case "subsystem":
						_ = r.Reply(true, nil)
						srv, _ := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(s.sftpRoot))
						go func() { _ = srv.Serve(); ch.Close() }()
					case "shell":
						_ = r.Reply(true, nil)
						go func() { _, _ = io.Copy(ch, ch) }() // echo shell
					case "pty-req", "env":
						_ = r.Reply(true, nil)
					default:
						_ = r.Reply(false, nil)
					}
				}
			}()
		default:
			_ = nc.Reject(ssh.UnknownChannelType, "no")
		}
	}
}

func echoServer(t *testing.T) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(c, c); c.Close() }()
		}
	}()
	return ln.Addr().String()
}

// newTestApp isolates Remterm's data folder and known_hosts in temp dirs.
func newTestApp(t *testing.T, srv *testServer) *App {
	t.Helper()
	dir := t.TempDir()
	kh := filepath.Join(dir, "known_hosts")
	line := knownhosts.Line([]string{knownhosts.Normalize(srv.addr)}, srv.hostKey.PublicKey())
	if err := os.WriteFile(kh, []byte(line+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REMTERM_DATA_DIR", filepath.Join(dir, "data"))
	t.Setenv("REMTERM_KNOWN_HOSTS", kh)
	a := NewApp()
	st, err := OpenStore()
	if err != nil {
		t.Fatal(err)
	}
	a.store = st
	a.history = openCmdHistory()
	a.logs = openLogStore()
	t.Cleanup(a.stopAllTunnels)
	return a
}

func splitAddr(t *testing.T, addr string) (string, int) {
	h, p, _ := net.SplitHostPort(addr)
	n, _ := strconv.Atoi(p)
	return h, n
}

func freePort(t *testing.T) int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func roundTrip(t *testing.T, c net.Conn, msg string) {
	t.Helper()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write([]byte(msg)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != msg {
		t.Fatalf("echo mismatch: %q %v", buf, err)
	}
}

// ---- tests ----

func TestPasswordAuthAndWrongPassword(t *testing.T) {
	srv := startTestServer(t)
	a := newTestApp(t, srv)
	host, port := splitAddr(t, srv.addr)
	h := Host{Address: host, Port: port, User: "u", AuthMethod: "password"}

	c, err := a.connectHost(h, "pw", nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	c.Close()

	_, err = a.connectHost(h, "nope", nil)
	if err == nil || !strings.HasPrefix(err.Error(), errAuthFailed) {
		t.Fatalf("want AUTH_FAILED, got %v", err)
	}
}

func TestKeychainIdentityAndJumpChain(t *testing.T) {
	srv := startTestServer(t)
	a := newTestApp(t, srv)
	host, port := splitAddr(t, srv.addr)

	key, err := a.GenerateKey(GenerateKeyRequest{Label: "test", Type: "ed25519"})
	if err != nil {
		t.Fatal(err)
	}
	pub, _, _, _, err := ssh.ParseAuthorizedKey([]byte(key.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	srv.allowKey(pub)

	// Identity carries the username + key; the host only has an address.
	ident, err := a.SaveIdentity(Identity{Label: "deploy", Username: "u", KeyID: key.ID}, "")
	if err != nil {
		t.Fatal(err)
	}
	bastion, _ := a.SaveHost(Host{Name: "bastion", Address: host, Port: port, IdentityID: ident.ID, AuthMethod: "key"}, "", "")
	inner, _ := a.SaveHost(Host{Name: "inner", Address: host, Port: port, IdentityID: ident.ID, AuthMethod: "key", JumpHostID: bastion.ID}, "", "")
	// A third hop through "inner", which itself goes through "bastion".
	third, _ := a.SaveHost(Host{Name: "third", Address: host, Port: port, AuthMethod: "key", KeyID: key.ID, User: "u", JumpHostID: inner.ID}, "", "")

	c, err := a.connectHost(third, "", nil)
	if err != nil {
		t.Fatalf("chain connect: %v", err)
	}
	if len(c.hops) != 2 {
		t.Fatalf("want 2 jump hops, got %d", len(c.hops))
	}
	c.Close()

	// A loop in the chain is reported instead of recursing forever.
	_ = a.store.UpdateHost(bastion.ID, func(h *Host) { h.JumpHostID = third.ID })
	if _, err := a.connectHost(third, "", nil); err == nil || !strings.Contains(err.Error(), "loops") {
		t.Fatalf("want loop error, got %v", err)
	}
}

func TestGroupInheritance(t *testing.T) {
	srv := startTestServer(t)
	a := newTestApp(t, srv)
	_, _ = a.SaveGroup(GroupConfig{Path: "Clients", StartupCommand: "cd /srv", EnvVars: []EnvVar{{"A", "1"}, {"B", "parent"}}}, "")
	_, _ = a.SaveGroup(GroupConfig{Path: "Clients/Acme", EnvVars: []EnvVar{{"B", "child"}}, Scheme: "dracula"}, "")
	h := a.effectiveHost(Host{Group: "Clients/Acme", EnvVars: []EnvVar{{"C", "host"}}})
	if h.StartupCommand != "cd /srv" || h.Scheme != "dracula" {
		t.Fatalf("scalar inheritance wrong: %+v", h)
	}
	got := fmt.Sprint(h.EnvVars)
	if got != "[{A 1} {B child} {C host}]" {
		t.Fatalf("env merge wrong: %s", got)
	}
	if err := a.RenameGroup("Clients", "Customers"); err != nil {
		t.Fatal(err)
	}
	if gs := a.ListGroups(); gs[0].Path != "Customers" || gs[1].Path != "Customers/Acme" {
		t.Fatalf("rename failed: %+v", gs)
	}
}

func TestSftpBrowseAndTransfer(t *testing.T) {
	srv := startTestServer(t)
	a := newTestApp(t, srv)
	host, port := splitAddr(t, srv.addr)
	h, _ := a.SaveHost(Host{Name: "files", Address: host, Port: port, User: "u", AuthMethod: "password"}, "", "")

	home, err := a.OpenSftp(SftpRequest{SessionID: "s1", HostID: h.ID, Password: "pw"})
	if err != nil {
		t.Fatalf("open sftp: %v", err)
	}
	defer a.CloseSftp("s1")

	// Upload a local folder tree.
	local := t.TempDir()
	_ = os.MkdirAll(filepath.Join(local, "site", "css"), 0o755)
	_ = os.WriteFile(filepath.Join(local, "site", "index.html"), []byte("<h1>hi</h1>"), 0o644)
	_ = os.WriteFile(filepath.Join(local, "site", "css", "app.css"), bytes.Repeat([]byte("x"), 300_000), 0o644)
	if _, err := a.FsTransfer(TransferRequest{SrcFS: localFSID, Paths: []string{filepath.Join(local, "site")}, DstFS: "s1", DstDir: home}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		ents, _ := a.FsList("s1", home+"/site/css")
		return len(ents) == 1 && ents[0].Size == 300_000
	})

	// Rename, chmod, mkdir, delete.
	if err := a.FsRename("s1", home+"/site/index.html", home+"/site/home.html"); err != nil {
		t.Fatal(err)
	}
	if err := a.FsMkdir("s1", home+"/site/img"); err != nil {
		t.Fatal(err)
	}
	ents, _ := a.FsList("s1", home+"/site")
	names := []string{}
	for _, e := range ents {
		names = append(names, e.Name)
	}
	if strings.Join(names, ",") != "css,img,home.html" { // folders first
		t.Fatalf("listing: %v", names)
	}

	// Download back into another local folder.
	out := t.TempDir()
	if _, err := a.FsTransfer(TransferRequest{SrcFS: "s1", Paths: []string{home + "/site"}, DstFS: localFSID, DstDir: out}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		b, err := os.ReadFile(filepath.Join(out, "site", "home.html"))
		return err == nil && string(b) == "<h1>hi</h1>"
	})

	if err := a.FsDelete("s1", []string{home + "/site"}); err != nil {
		t.Fatal(err)
	}
	if ents, _ := a.FsList("s1", home); len(ents) != 0 {
		t.Fatalf("delete left %v", ents)
	}
}

func TestTunnelsLocalAndSocks(t *testing.T) {
	srv := startTestServer(t)
	a := newTestApp(t, srv)
	host, port := splitAddr(t, srv.addr)
	echo := echoServer(t)
	eh, ep := splitAddr(t, echo)
	h, _ := a.SaveHost(Host{Name: "gw", Address: host, Port: port, User: "u", AuthMethod: "password"}, "", "")

	// Local forward: localhost:lp → (ssh) → echo server.
	lp := freePort(t)
	lt, err := a.SaveTunnel(Tunnel{Type: "local", HostID: h.ID, Port: lp, DestHost: eh, DestPort: ep})
	if err != nil {
		t.Fatal(err)
	}
	if err := a.StartTunnel(lt.ID, "pw"); err != nil {
		t.Fatal(err)
	}
	c, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(lp))
	if err != nil {
		t.Fatal(err)
	}
	roundTrip(t, c, "through the tunnel")
	c.Close()
	a.StopTunnel(lt.ID)
	if _, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(lp), time.Second); err == nil {
		t.Fatal("port still open after stop")
	}

	// Dynamic: SOCKS5 proxy on localhost, used by a standard SOCKS client.
	dp := freePort(t)
	dt, _ := a.SaveTunnel(Tunnel{Type: "dynamic", HostID: h.ID, Port: dp})
	if err := a.StartTunnel(dt.ID, "pw"); err != nil {
		t.Fatal(err)
	}
	dialer, _ := proxy.SOCKS5("tcp", "127.0.0.1:"+strconv.Itoa(dp), nil, proxy.Direct)
	sc, err := dialer.Dial("tcp", echo)
	if err != nil {
		t.Fatalf("socks dial: %v", err)
	}
	roundTrip(t, sc, "via socks")
	sc.Close()
}

func TestConnectThroughSocksProxy(t *testing.T) {
	srv := startTestServer(t)
	a := newTestApp(t, srv)
	host, port := splitAddr(t, srv.addr)

	// A SOCKS5 proxy (reusing Remterm's own handler with direct dialing).
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	var used sync.WaitGroup
	used.Add(1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		used.Done()
		serveSOCKS5(c, net.Dial)
	}()
	ph, pp := splitAddr(t, ln.Addr().String())
	h := Host{Address: host, Port: port, User: "u", AuthMethod: "password", Proxy: &Proxy{Type: "socks5", Host: ph, Port: pp}}
	c, err := a.connectHost(h, "pw", nil)
	if err != nil {
		t.Fatalf("connect via proxy: %v", err)
	}
	c.Close()
	used.Wait()
}

func TestTelnetNegotiationAndAutoLogin(t *testing.T) {
	a := newTestApp(t, startTestServer(t))
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	got := make(chan string, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		// Ask for window size, then prompt for a login.
		_, _ = c.Write([]byte{tnIAC, tnDO, optNAWS})
		_, _ = c.Write([]byte("\r\nrouter login: "))
		buf := make([]byte, 0, 64)
		tmp := make([]byte, 64)
		deadline := time.Now().Add(3 * time.Second)
		_ = c.SetReadDeadline(deadline)
		for !bytes.Contains(buf, []byte("admin\r\n")) {
			n, err := c.Read(tmp)
			if err != nil {
				break
			}
			buf = append(buf, tmp[:n]...)
		}
		got <- string(buf)
	}()
	host, port := splitAddr(t, ln.Addr().String())
	h, _ := a.SaveHost(Host{Name: "router", Protocol: "telnet", Address: host, Port: port, User: "admin"}, "", "")
	if err := a.openTelnet(ConnectRequest{SessionID: "t1", Cols: 100, Rows: 30}, h); err != nil {
		t.Fatal(err)
	}
	defer a.Disconnect("t1")
	select {
	case s := <-got:
		// WILL NAWS + window size 100x30, then the username.
		naws := string([]byte{tnIAC, tnSB, optNAWS, 0, 100, 0, 30, tnIAC, tnSE})
		if !strings.Contains(s, string([]byte{tnIAC, tnWILL, optNAWS})) || !strings.Contains(s, naws) || !strings.Contains(s, "admin\r\n") {
			t.Fatalf("unexpected client bytes: %q", s)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no telnet login")
	}
}

func TestSessionLogRetentionAndPlainText(t *testing.T) {
	a := newTestApp(t, startTestServer(t))
	for i := 0; i < logsKeptPerHost+2; i++ {
		l := a.logs.start("ssh:x", "x")
		l.write([]byte("\x1b[32mok\x1b[0m line " + strconv.Itoa(i) + "\r\n"))
		l.finish()
		time.Sleep(2 * time.Millisecond)
	}
	logs := a.ListLogs()
	if len(logs) != logsKeptPerHost {
		t.Fatalf("kept %d logs, want %d", len(logs), logsKeptPerHost)
	}
	_ = a.SetLogBookmark(logs[len(logs)-1].ID, true, "keep me")
	l := a.logs.start("ssh:x", "x")
	l.finish()
	found := false
	for _, e := range a.ListLogs() {
		found = found || e.Comment == "keep me"
	}
	if !found {
		t.Fatal("bookmarked log was pruned")
	}
	if got := plainText([]byte("\x1b[1;31mERR\x1b[0m done\r\nab\bc\r\n")); got != "ERR done\nac\n\n" {
		t.Fatalf("plainText = %q", got)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("timed out")
}
