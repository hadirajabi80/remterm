package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Port forwarding rules, like `ssh -L`, `ssh -R` and `ssh -D`. Each running
// rule has its own SSH connection; auto-start rules start with Remterm and
// reconnect when the connection drops.

type TunnelStatus struct {
	ID    string `json:"id"`
	State string `json:"state"` // stopped | starting | running | error
	Error string `json:"error"`
	Conns int32  `json:"conns"` // open forwarded connections
}

// runningTunnel is registered as soon as a start begins, so stopping works
// while it is still connecting; conn and ln are attached once they exist.
type runningTunnel struct {
	stop    chan struct{}
	once    sync.Once
	mu      sync.Mutex // guards conn and ln
	conn    *sshConn
	ln      net.Listener
	conns   atomic.Int32
	stopped atomic.Bool
}

func (r *runningTunnel) close() {
	r.once.Do(func() {
		r.mu.Lock()
		r.stopped.Store(true)
		ln, conn := r.ln, r.conn
		r.mu.Unlock()
		close(r.stop)
		if ln != nil {
			ln.Close()
		}
		if conn != nil {
			conn.Close()
		}
	})
}

// attach records the connection or listener a start just opened. It returns
// false when the tunnel was stopped meanwhile; the caller closes it then.
func (r *runningTunnel) attach(conn *sshConn, ln net.Listener) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped.Load() {
		return false
	}
	if conn != nil {
		r.conn = conn
	}
	if ln != nil {
		r.ln = ln
	}
	return true
}

type tunnelManager struct {
	mu      sync.Mutex
	running map[string]*runningTunnel
	status  map[string]TunnelStatus
	retry   map[string]chan struct{} // closed to cancel a reconnect loop
}

func (a *App) setTunnelStatus(st TunnelStatus) {
	a.tunnels.mu.Lock()
	a.tunnels.status[st.ID] = st
	a.tunnels.mu.Unlock()
	a.emit("tunnel:status", st)
}

// setTunnelStatusFor sets st only while r is still the registered run of the
// rule, so a stopped or replaced start can't overwrite the newer status.
func (a *App) setTunnelStatusFor(r *runningTunnel, st TunnelStatus) bool {
	a.tunnels.mu.Lock()
	ok := a.tunnels.running[st.ID] == r
	if ok {
		a.tunnels.status[st.ID] = st
	}
	a.tunnels.mu.Unlock()
	if ok {
		a.emit("tunnel:status", st)
	}
	return ok
}

// endTunnel closes r and, if it is still the registered run of the rule,
// unregisters it and reports st. It returns false when r was already stopped
// or replaced (the newer state stands).
func (a *App) endTunnel(r *runningTunnel, st TunnelStatus) bool {
	a.tunnels.mu.Lock()
	ok := a.tunnels.running[st.ID] == r
	if ok {
		delete(a.tunnels.running, st.ID)
		a.tunnels.status[st.ID] = st
	}
	a.tunnels.mu.Unlock()
	r.close()
	if ok {
		a.emit("tunnel:status", st)
	}
	return ok
}

func (a *App) ListTunnels() []Tunnel {
	var out []Tunnel
	a.store.read(func(d *storeData) { out = append(out, d.Tunnels...) })
	return out
}

func (a *App) TunnelStatuses() []TunnelStatus {
	a.tunnels.mu.Lock()
	defer a.tunnels.mu.Unlock()
	out := make([]TunnelStatus, 0, len(a.tunnels.status))
	for id, st := range a.tunnels.status {
		if r := a.tunnels.running[id]; r != nil {
			st.Conns = r.conns.Load()
		}
		out = append(out, st)
	}
	return out
}

func (a *App) SaveTunnel(t Tunnel) (Tunnel, error) {
	t.Label = strings.TrimSpace(t.Label)
	t.DestHost = strings.TrimSpace(t.DestHost)
	t.BindAddress = strings.TrimSpace(t.BindAddress)
	switch t.Type {
	case "local", "remote", "dynamic":
	default:
		return t, errors.New("choose Local, Remote or Dynamic")
	}
	if t.HostID == "" {
		return t, errors.New("choose the SSH host that carries the traffic")
	}
	if t.Port <= 0 || t.Port > 65535 {
		return t, errors.New("enter a port between 1 and 65535")
	}
	if t.Type != "dynamic" && (t.DestHost == "" || t.DestPort <= 0 || t.DestPort > 65535) {
		return t, errors.New("enter the destination address and port")
	}
	if t.ID == "" {
		t.ID = newID()
	}
	if t.Label == "" {
		switch t.Type {
		case "dynamic":
			t.Label = fmt.Sprintf("SOCKS :%d", t.Port)
		default:
			t.Label = fmt.Sprintf("%d → %s:%d", t.Port, t.DestHost, t.DestPort)
		}
	}
	a.tunnels.mu.Lock()
	wasRunning := a.tunnels.running[t.ID] != nil || a.tunnels.retry[t.ID] != nil
	a.tunnels.mu.Unlock()
	a.StopTunnel(t.ID) // restart with the new settings if it was running
	if err := a.store.withLock(func(d *storeData) { d.Tunnels = upsert(d.Tunnels, t, tunnelID) }); err != nil {
		return t, err
	}
	if wasRunning {
		go func() {
			if a.StartTunnel(t.ID, "") != nil && t.AutoStart {
				a.retryTunnel(t.ID)
			}
		}()
	}
	return t, nil
}

func (a *App) DeleteTunnel(id string) error {
	a.StopTunnel(id)
	a.tunnels.mu.Lock()
	delete(a.tunnels.status, id)
	a.tunnels.mu.Unlock()
	return a.store.withLock(func(d *storeData) { d.Tunnels = without(d.Tunnels, id, tunnelID) })
}

// StopTunnel stops the rule whether it is running, starting or waiting to
// reconnect.
func (a *App) StopTunnel(id string) {
	a.tunnels.mu.Lock()
	retry := a.tunnels.retry[id]
	delete(a.tunnels.retry, id)
	a.tunnels.mu.Unlock()
	if retry != nil {
		close(retry)
	}
	if a.stopRunning(id) || retry != nil {
		a.setTunnelStatus(TunnelStatus{ID: id, State: "stopped"})
	}
}

// stopRunning stops the running (or starting) run of rule id, if any.
func (a *App) stopRunning(id string) bool {
	a.tunnels.mu.Lock()
	r := a.tunnels.running[id]
	delete(a.tunnels.running, id)
	a.tunnels.mu.Unlock()
	if r != nil {
		r.close()
	}
	return r != nil
}

// StartTunnel connects and starts listening. password is only needed when
// the host has no saved credentials (AUTH_FAILED asks the UI for it).
func (a *App) StartTunnel(id, password string) error {
	t, ok := find(a.ListTunnels(), id, tunnelID)
	if !ok {
		return errors.New("port forwarding rule not found")
	}
	h, ok := a.store.Host(t.HostID)
	if !ok {
		return errors.New("the SSH host of this rule was deleted")
	}
	a.stopRunning(id) // not StopTunnel: a pending reconnect loop may be the caller

	r := &runningTunnel{stop: make(chan struct{})}
	a.tunnels.mu.Lock()
	if a.tunnels.running[id] != nil { // another start got in first
		a.tunnels.mu.Unlock()
		return errors.New("port forwarding is already starting or running")
	}
	a.tunnels.running[id] = r
	a.tunnels.mu.Unlock()
	a.setTunnelStatusFor(r, TunnelStatus{ID: id, State: "starting"})

	conn, err := a.connectHost(h, password, nil)
	if err != nil {
		if !a.endTunnel(r, TunnelStatus{ID: id, State: "error", Error: cleanAuthMarker(err)}) {
			return nil // stopped while connecting
		}
		return err
	}
	if !r.attach(conn, nil) {
		conn.Close()
		return nil
	}
	bind := t.BindAddress
	if bind == "" {
		bind = "127.0.0.1"
	}
	listen := net.JoinHostPort(bind, strconv.Itoa(t.Port))
	dest := net.JoinHostPort(t.DestHost, strconv.Itoa(t.DestPort))

	var ln net.Listener
	switch t.Type {
	case "remote":
		ln, err = conn.client.Listen("tcp", listen)
		if err != nil {
			err = fmt.Errorf("server refused to listen on %s (port in use, or GatewayPorts off for non-local addresses): %w", listen, err)
		}
	default:
		ln, err = net.Listen("tcp", listen)
		if err != nil {
			err = fmt.Errorf("cannot listen on %s (port already in use?): %w", listen, err)
		}
	}
	if err != nil {
		if !a.endTunnel(r, TunnelStatus{ID: id, State: "error", Error: err.Error()}) {
			return nil
		}
		return err
	}
	if !r.attach(nil, ln) {
		ln.Close()
		return nil
	}
	if !a.setTunnelStatusFor(r, TunnelStatus{ID: id, State: "running"}) {
		return nil // stopped just now; whoever stopped it closed it
	}

	go func() { // accept loop
		for retries := 0; ; {
			c, err := ln.Accept()
			if err != nil {
				// Closed: stopped, or (io.EOF from an SSH listener) the
				// connection dropped and the watchdog takes over.
				if r.stopped.Load() || errors.Is(err, net.ErrClosed) || errors.Is(err, io.EOF) {
					return
				}
				if ne, ok := err.(net.Error); ok && ne.Temporary() && retries < 50 { // ~5s
					retries++
					time.Sleep(100 * time.Millisecond)
					continue
				}
				a.endTunnel(r, TunnelStatus{ID: id, State: "error", Error: err.Error()})
				return
			}
			retries = 0
			r.conns.Add(1)
			go func() {
				defer r.conns.Add(-1)
				switch t.Type {
				case "local":
					if remote, err := dialTimeout(conn.client.Dial, dest, 30*time.Second); err == nil {
						pipe(c, remote)
					} else {
						c.Close()
					}
				case "remote":
					if local, err := net.DialTimeout("tcp", dest, 10*time.Second); err == nil {
						pipe(c, local)
					} else {
						c.Close()
					}
				case "dynamic":
					serveSOCKS5(c, conn.client.Dial)
				}
			}()
		}
	}()

	go tunnelKeepalive(r, conn)

	go func() { // connection watchdog
		_ = conn.client.Wait()
		if !a.endTunnel(r, TunnelStatus{ID: id, State: "error", Error: "SSH connection lost"}) {
			return // stopped or replaced
		}
		if t.AutoStart {
			a.retryTunnel(id)
		}
	}()
	return nil
}

// tunnelKeepalive probes the tunnel's SSH connection so a silent drop is
// noticed: after two failed probes it closes the connection and the
// watchdog takes over.
func tunnelKeepalive(r *runningTunnel, conn *sshConn) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	failures := 0
	for {
		select {
		case <-r.stop:
			return
		case <-ticker.C:
		}
		res := make(chan error, 1)
		go func() {
			_, _, err := conn.client.SendRequest("keepalive@openssh.com", true, nil)
			res <- err
		}()
		select {
		case <-r.stop:
			return
		case err := <-res:
			if err != nil {
				failures++
			} else {
				failures = 0
			}
		case <-time.After(20 * time.Second):
			failures++
		}
		if failures >= 2 {
			conn.Close()
			return
		}
	}
}

// retryTunnel reconnects rule id with backoff until it runs, stops being
// auto-start, or StopTunnel cancels it. One loop per rule.
func (a *App) retryTunnel(id string) {
	a.tunnels.mu.Lock()
	if a.tunnels.retry[id] != nil {
		a.tunnels.mu.Unlock()
		return
	}
	if a.tunnels.retry == nil {
		a.tunnels.retry = map[string]chan struct{}{}
	}
	cancel := make(chan struct{})
	a.tunnels.retry[id] = cancel
	a.tunnels.mu.Unlock()
	defer func() {
		a.tunnels.mu.Lock()
		if a.tunnels.retry[id] == cancel {
			delete(a.tunnels.retry, id)
		}
		a.tunnels.mu.Unlock()
	}()

	for delay := 2 * time.Second; ; delay = min(delay*2, time.Minute) {
		select {
		case <-cancel:
			return
		case <-time.After(delay):
		}
		t, ok := find(a.ListTunnels(), id, tunnelID)
		if !ok || !t.AutoStart {
			return
		}
		a.tunnels.mu.Lock()
		_, running := a.tunnels.running[id]
		a.tunnels.mu.Unlock()
		if running || a.StartTunnel(id, "") == nil {
			return
		}
	}
}

func (a *App) startAutoTunnels() {
	for _, t := range a.ListTunnels() {
		if t.AutoStart {
			go func(id string) {
				if a.StartTunnel(id, "") != nil {
					a.retryTunnel(id)
				}
			}(t.ID)
		}
	}
}

func (a *App) stopAllTunnels() {
	a.tunnels.mu.Lock()
	all := a.tunnels.running
	a.tunnels.running = map[string]*runningTunnel{}
	retries := a.tunnels.retry
	a.tunnels.retry = nil
	a.tunnels.mu.Unlock()
	for _, ch := range retries {
		close(ch)
	}
	for _, r := range all {
		r.close()
	}
}

type closeWriter interface{ CloseWrite() error }

// pipe copies both ways. When one side finishes sending, only that direction
// is closed (half-close) so the answer still flows back; TCP and SSH channel
// connections support it.
func pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		_, err := io.Copy(dst, src)
		if cw, ok := dst.(closeWriter); ok && err == nil {
			_ = cw.CloseWrite()
		} else { // can't half-close, or the copy failed: end both directions
			a.Close()
			b.Close()
		}
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	<-done
	a.Close()
	b.Close()
}

// dialTimeout gives up on dial after d; a connection that arrives later is closed.
func dialTimeout(dial func(network, addr string) (net.Conn, error), addr string, d time.Duration) (net.Conn, error) {
	type result struct {
		c   net.Conn
		err error
	}
	res := make(chan result, 1)
	go func() {
		c, err := dial("tcp", addr)
		res <- result{c, err}
	}()
	select {
	case r := <-res:
		return r.c, r.err
	case <-time.After(d):
		go func() {
			if r := <-res; r.c != nil {
				r.c.Close()
			}
		}()
		return nil, fmt.Errorf("connecting to %s timed out", addr)
	}
}

// serveSOCKS5 handles one SOCKS5 CONNECT request (no auth), dialing the
// target through SSH. That is all browsers and most tools need.
func serveSOCKS5(c net.Conn, dial func(network, addr string) (net.Conn, error)) {
	_ = c.SetDeadline(time.Now().Add(15 * time.Second))
	hdr := make([]byte, 2)
	if _, err := io.ReadFull(c, hdr); err != nil || hdr[0] != 5 {
		c.Close()
		return
	}
	if _, err := io.ReadFull(c, make([]byte, hdr[1])); err != nil {
		c.Close()
		return
	}
	_, _ = c.Write([]byte{5, 0}) // no authentication
	req := make([]byte, 4)
	if _, err := io.ReadFull(c, req); err != nil || req[1] != 1 { // CONNECT only
		_, _ = c.Write([]byte{5, 7, 0, 1, 0, 0, 0, 0, 0, 0})
		c.Close()
		return
	}
	var host string
	switch req[3] {
	case 1:
		b := make([]byte, 4)
		if _, err := io.ReadFull(c, b); err != nil {
			c.Close()
			return
		}
		host = net.IP(b).String()
	case 4:
		b := make([]byte, 16)
		if _, err := io.ReadFull(c, b); err != nil {
			c.Close()
			return
		}
		host = net.IP(b).String()
	case 3:
		l := make([]byte, 1)
		if _, err := io.ReadFull(c, l); err != nil {
			c.Close()
			return
		}
		b := make([]byte, l[0])
		if _, err := io.ReadFull(c, b); err != nil {
			c.Close()
			return
		}
		host = string(b)
	default:
		_, _ = c.Write([]byte{5, 8, 0, 1, 0, 0, 0, 0, 0, 0})
		c.Close()
		return
	}
	pb := make([]byte, 2)
	if _, err := io.ReadFull(c, pb); err != nil {
		c.Close()
		return
	}
	target := net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(pb))))
	_ = c.SetDeadline(time.Time{}) // the request is in; the dial has its own timeout
	remote, err := dialTimeout(dial, target, 30*time.Second)
	if err != nil {
		_, _ = c.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
		c.Close()
		return
	}
	if _, err := c.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
		c.Close()
		remote.Close()
		return
	}
	pipe(c, remote)
}
