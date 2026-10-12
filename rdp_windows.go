//go:build windows

package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// Remote Desktop runs in RemtermRdp.exe (C#/WinForms: the Windows RDP
// ActiveX, the encrypted RDP vault, WALLIX auto-fill). Remterm starts it,
// serves it a private named pipe and relays JSON calls from the UI; its RDP
// views are native child windows of Remterm's main window, positioned by the
// UI over the tab content.

const rdpEngineExe = "RemtermRdp.exe"

type rdpReply struct {
	result json.RawMessage
	err    string
}

type rdpEngine struct {
	app *App

	mu       sync.Mutex
	conn     net.Conn
	cmd      *exec.Cmd
	pid      int
	starting chan struct{} // closed when a start attempt finished
	startErr error
	closed   bool

	writeMu sync.Mutex
	nextID  atomic.Int64
	pendMu  sync.Mutex
	pending map[int64]chan rdpReply
}

func newRdpEngine(a *App) *rdpEngine {
	return &rdpEngine{app: a, pending: map[int64]chan rdpReply{}}
}

func rdpEnginePath() string {
	exe, err := os.Executable()
	if err != nil {
		return rdpEngineExe
	}
	return filepath.Join(filepath.Dir(exe), rdpEngineExe)
}

// RdpAvailable reports whether the Remote Desktop engine is installed next to Remterm.
func (a *App) RdpAvailable() bool {
	_, err := os.Stat(rdpEnginePath())
	return err == nil
}

// RdpCall forwards one call to the Remote Desktop engine. params and the
// result are JSON text.
func (a *App) RdpCall(method, params string) (string, error) {
	if params == "" {
		params = "{}"
	}
	if os.Getenv("REMTERM_RDP_WEB") == "1" { // developer switch: try the macOS in-tab engine (IronRDP) here
		if res, ok, err := a.webRdpDev(method, params); ok {
			return res, err
		}
	}
	timeout := 30 * time.Second
	if method == "fill" || method == "close" {
		timeout = 10 * time.Minute // the login picker waits for the user
	}
	res, err := a.rdp.call(method, json.RawMessage(params), timeout)
	if err != nil {
		return "", err
	}
	return string(res), nil
}

// webRdpDev serves the IronRDP path on Windows for testing: typed addresses only (no vault access).
func (a *App) webRdpDev(method, params string) (string, bool, error) {
	switch method {
	case "data":
		res, err := a.rdp.call("data", json.RawMessage("{}"), 30*time.Second)
		if err != nil {
			return "", true, err
		}
		var m map[string]any
		_ = json.Unmarshal(res, &m)
		m["web"] = true
		out, _ := json.Marshal(m)
		return string(out), true, nil
	case "webSession":
		var p struct {
			Machine struct {
				IP string `json:"ip"`
			} `json:"machine"`
		}
		_ = json.Unmarshal([]byte(params), &p)
		dest := p.Machine.IP
		if dest == "" {
			return "", true, errors.New("developer mode: only typed addresses")
		}
		if !strings.Contains(dest, ":") {
			dest += ":3389"
		}
		proxy, token, err := a.relay.grant(dest)
		if err != nil {
			return "", true, err
		}
		out, _ := json.Marshal(WebRdpSession{Proxy: proxy, Token: token, Destination: dest, Username: os.Getenv("REMTERM_RDP_WEB_USER"), Password: os.Getenv("REMTERM_RDP_WEB_PASS")})
		return string(out), true, nil
	}
	return "", false, nil
}

// ensure starts the engine once and waits until it said hello.
func (e *rdpEngine) ensure() error {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return errors.New("Remterm is closing")
	}
	if e.conn != nil {
		e.mu.Unlock()
		return nil
	}
	if e.starting == nil {
		e.starting = make(chan struct{})
		go e.start(e.starting)
	}
	ch := e.starting
	e.mu.Unlock()
	<-ch
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.conn != nil {
		return nil
	}
	return e.startErr
}

func (e *rdpEngine) start(done chan struct{}) {
	conn, cmd, err := e.launch()
	e.mu.Lock()
	e.starting = nil
	e.startErr = err
	if err == nil {
		e.conn, e.cmd, e.pid = conn, cmd, cmd.Process.Pid
	}
	e.mu.Unlock()
	close(done)
	if err == nil {
		go e.readLoop(conn)
		go func() {
			_ = cmd.Wait()
			e.dropped(conn)
		}()
	}
}

func (e *rdpEngine) launch() (net.Conn, *exec.Cmd, error) {
	exe := rdpEnginePath()
	if _, err := os.Stat(exe); err != nil {
		return nil, nil, fmt.Errorf("Remote Desktop is not installed (%s is missing next to Remterm.exe) — reinstall Remterm", rdpEngineExe)
	}
	hwnd := mainWindow()
	if hwnd == 0 {
		return nil, nil, errors.New("Remterm's window is not ready yet")
	}

	b := make([]byte, 16)
	_, _ = rand.Read(b)
	token := hex.EncodeToString(b)
	name := fmt.Sprintf(`\\.\pipe\remterm-rdp-%d-%s`, os.Getpid(), token[:12])
	sddl, err := currentUserOnlySDDL()
	if err != nil {
		return nil, nil, err
	}
	ln, err := winio.ListenPipe(name, &winio.PipeConfig{SecurityDescriptor: sddl, InputBufferSize: 1 << 16, OutputBufferSize: 1 << 20})
	if err != nil {
		return nil, nil, fmt.Errorf("open pipe: %w", err)
	}
	defer ln.Close() // one client only

	cmd := exec.Command(exe, "--pipe", name[len(`\\.\pipe\`):], "--token", token, "--parent", strconv.FormatUint(uint64(hwnd), 10))
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		return nil, nil, fmt.Errorf("start %s: %w", rdpEngineExe, err)
	}

	type accepted struct {
		c   net.Conn
		err error
	}
	ac := make(chan accepted, 1)
	go func() {
		c, err := ln.Accept()
		ac <- accepted{c, err}
	}()
	var conn net.Conn
	select {
	case r := <-ac:
		if r.err != nil {
			_ = cmd.Process.Kill()
			return nil, nil, r.err
		}
		conn = r.c
	case <-time.After(20 * time.Second):
		_ = cmd.Process.Kill()
		return nil, nil, errors.New("the Remote Desktop engine did not start")
	}

	// The first line must be the hello with our token: proves the client is the engine we started.
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	r := bufio.NewReaderSize(conn, 1<<16)
	line, err := r.ReadBytes('\n')
	var hello struct {
		Event string `json:"event"`
		Data  struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if err != nil || json.Unmarshal(line, &hello) != nil || hello.Event != "hello" || hello.Data.Token != token {
		conn.Close()
		_ = cmd.Process.Kill()
		return nil, nil, errors.New("the Remote Desktop engine did not answer")
	}
	_ = conn.SetReadDeadline(time.Time{})
	return &bufferedConn{Conn: conn, r: r}, cmd, nil
}

// bufferedConn keeps bytes already read past the hello line.
type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufferedConn) Read(p []byte) (int, error) { return b.r.Read(p) }

func (e *rdpEngine) readLoop(conn net.Conn) {
	r := bufio.NewReaderSize(conn, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			e.handle(line)
		}
		if err != nil {
			e.dropped(conn)
			return
		}
	}
}

func (e *rdpEngine) handle(line []byte) {
	var msg struct {
		ID     int64           `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
		Event  string          `json:"event"`
		Data   json.RawMessage `json:"data"`
	}
	if json.Unmarshal(line, &msg) != nil {
		return
	}
	if msg.Event != "" {
		e.app.emit("rdp:event", msg.Event, msg.Data)
		return
	}
	e.pendMu.Lock()
	ch := e.pending[msg.ID]
	delete(e.pending, msg.ID)
	e.pendMu.Unlock()
	if ch != nil {
		ch <- rdpReply{result: msg.Result, err: msg.Error}
	}
}

// dropped runs when the engine exits or the pipe breaks: fail waiting calls
// and tell the UI (open RDP tabs show "disconnected"); the next call restarts it.
func (e *rdpEngine) dropped(conn net.Conn) {
	e.mu.Lock()
	if e.conn != conn {
		e.mu.Unlock()
		return
	}
	e.conn = nil
	closing := e.closed
	e.mu.Unlock()
	conn.Close()

	e.pendMu.Lock()
	for id, ch := range e.pending {
		ch <- rdpReply{err: "the Remote Desktop engine stopped"}
		delete(e.pending, id)
	}
	e.pendMu.Unlock()
	if !closing {
		e.app.emit("rdp:event", "engine-exit", nil)
	}
}

func (e *rdpEngine) call(method string, params json.RawMessage, timeout time.Duration) (json.RawMessage, error) {
	if err := e.ensure(); err != nil {
		return nil, err
	}
	e.mu.Lock()
	conn, pid := e.conn, e.pid
	e.mu.Unlock()
	if conn == nil {
		return nil, errors.New("the Remote Desktop engine stopped")
	}
	// Remterm is the foreground app while the user clicks; let the engine
	// bring its own windows (login picker, pop-out, fullscreen) to the front.
	allowSetForegroundWindow(pid)

	id := e.nextID.Add(1)
	ch := make(chan rdpReply, 1)
	e.pendMu.Lock()
	e.pending[id] = ch
	e.pendMu.Unlock()

	line, _ := json.Marshal(struct {
		ID     int64           `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}{id, method, params})
	e.writeMu.Lock()
	_, err := conn.Write(append(line, '\n'))
	e.writeMu.Unlock()
	if err != nil {
		e.pendMu.Lock()
		delete(e.pending, id)
		e.pendMu.Unlock()
		return nil, fmt.Errorf("Remote Desktop engine: %w", err)
	}

	select {
	case r := <-ch:
		if r.err != "" {
			return nil, errors.New(r.err)
		}
		if len(r.result) == 0 {
			return json.RawMessage("null"), nil
		}
		return r.result, nil
	case <-time.After(timeout):
		e.pendMu.Lock()
		delete(e.pending, id)
		e.pendMu.Unlock()
		return nil, errors.New("the Remote Desktop engine did not respond")
	}
}

// connectedSessions asks how many RDP sessions are live (0 when the engine is not running).
func (e *rdpEngine) connectedSessions() int {
	e.mu.Lock()
	running := e.conn != nil
	e.mu.Unlock()
	if !running {
		return 0
	}
	res, err := e.call("connectedCount", json.RawMessage("{}"), 3*time.Second)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(string(res))
	return n
}

func (e *rdpEngine) stop() {
	e.mu.Lock()
	e.closed = true
	conn, cmd := e.conn, e.cmd
	e.mu.Unlock()
	if conn != nil {
		conn.Close() // the engine disconnects its sessions and exits
	}
	if cmd != nil && cmd.Process != nil {
		done := make(chan struct{})
		go func() {
			_, _ = cmd.Process.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			_ = cmd.Process.Kill()
		}
	}
}

// beforeClose asks before quitting with live RDP sessions.
func (a *App) beforeClose(ctx context.Context) bool {
	n := a.rdp.connectedSessions()
	if n == 0 {
		return false
	}
	text := fmt.Sprintf("Disconnect %d Remote Desktop session%s and quit Remterm?", n, map[bool]string{true: "", false: "s"}[n == 1])
	t, _ := windows.UTF16PtrFromString("Remterm")
	m, _ := windows.UTF16PtrFromString(text)
	ret, _ := windows.MessageBox(windows.HWND(mainWindow()), m, t, windows.MB_YESNO|windows.MB_ICONQUESTION)
	return ret != idYes
}

// ---- Win32 ----

var (
	user32                       = windows.NewLazySystemDLL("user32.dll")
	procFindWindowExW            = user32.NewProc("FindWindowExW")
	procAllowSetForegroundWindow = user32.NewProc("AllowSetForegroundWindow")
)

// mainWindow finds this process's Wails window by its class name.
func mainWindow() uintptr {
	class, _ := windows.UTF16PtrFromString(mainWindowClass)
	var after uintptr
	for i := 0; i < 64; i++ {
		h, _, _ := procFindWindowExW.Call(0, after, uintptr(unsafe.Pointer(class)), 0)
		if h == 0 {
			return 0
		}
		var pid uint32
		_, _ = windows.GetWindowThreadProcessId(windows.HWND(h), &pid)
		if int(pid) == os.Getpid() {
			return h
		}
		after = h
	}
	return 0
}

func allowSetForegroundWindow(pid int) {
	if pid > 0 {
		_, _, _ = procAllowSetForegroundWindow.Call(uintptr(pid))
	}
}

// currentUserOnlySDDL limits the pipe to this Windows account.
func currentUserOnlySDDL() (string, error) {
	tok := windows.GetCurrentProcessToken()
	u, err := tok.GetTokenUser()
	if err != nil {
		return "", err
	}
	return "D:P(A;;GA;;;" + u.User.Sid.String() + ")", nil
}
