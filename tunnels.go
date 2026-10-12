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

type runningTunnel struct {
	stop    chan struct{}
	once    sync.Once
	conn    *sshConn
	ln      net.Listener
	conns   atomic.Int32
	stopped atomic.Bool
}

func (r *runningTunnel) close() {
	r.once.Do(func() {
		r.stopped.Store(true)
		close(r.stop)
		if r.ln != nil {
			r.ln.Close()
		}
		if r.conn != nil {
			r.conn.Close()
		}
	})
}

type tunnelManager struct {
	mu      sync.Mutex
	running map[string]*runningTunnel
	status  map[string]TunnelStatus
}

func (a *App) setTunnelStatus(st TunnelStatus) {
	a.tunnels.mu.Lock()
	a.tunnels.status[st.ID] = st
	a.tunnels.mu.Unlock()
	a.emit("tunnel:status", st)
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
	a.StopTunnel(t.ID) // restart with the new settings if it was running
	return t, a.store.withLock(func(d *storeData) { d.Tunnels = upsert(d.Tunnels, t, tunnelID) })
}

func (a *App) DeleteTunnel(id string) error {
	a.StopTunnel(id)
	a.tunnels.mu.Lock()
	delete(a.tunnels.status, id)
	a.tunnels.mu.Unlock()
	return a.store.withLock(func(d *storeData) { d.Tunnels = without(d.Tunnels, id, tunnelID) })
}

func (a *App) StopTunnel(id string) {
	a.tunnels.mu.Lock()
	r := a.tunnels.running[id]
	delete(a.tunnels.running, id)
	a.tunnels.mu.Unlock()
	if r != nil {
		r.close()
		a.setTunnelStatus(TunnelStatus{ID: id, State: "stopped"})
	}
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
	a.StopTunnel(id)
	a.setTunnelStatus(TunnelStatus{ID: id, State: "starting"})

	conn, err := a.connectHost(h, password, nil)
	if err != nil {
		a.setTunnelStatus(TunnelStatus{ID: id, State: "error", Error: cleanAuthMarker(err)})
		return err
	}
	r := &runningTunnel{stop: make(chan struct{}), conn: conn}
	bind := t.BindAddress
	if bind == "" {
		bind = "127.0.0.1"
	}
	listen := net.JoinHostPort(bind, strconv.Itoa(t.Port))
	dest := net.JoinHostPort(t.DestHost, strconv.Itoa(t.DestPort))

	switch t.Type {
	case "remote":
		r.ln, err = conn.client.Listen("tcp", listen)
		if err != nil {
			err = fmt.Errorf("server refused to listen on %s (port in use, or GatewayPorts off for non-local addresses): %w", listen, err)
		}
	default:
		r.ln, err = net.Listen("tcp", listen)
		if err != nil {
			err = fmt.Errorf("cannot listen on %s (port already in use?): %w", listen, err)
		}
	}
	if err != nil {
		conn.Close()
		a.setTunnelStatus(TunnelStatus{ID: id, State: "error", Error: err.Error()})
		return err
	}

	a.tunnels.mu.Lock()
	a.tunnels.running[id] = r
	a.tunnels.mu.Unlock()
	a.setTunnelStatus(TunnelStatus{ID: id, State: "running"})

	go func() { // accept loop
		for {
			c, err := r.ln.Accept()
			if err != nil {
				return
			}
			r.conns.Add(1)
			go func() {
				defer r.conns.Add(-1)
				switch t.Type {
				case "local":
					if remote, err := conn.client.Dial("tcp", dest); err == nil {
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

	go func() { // connection watchdog
		_ = conn.client.Wait()
		if r.stopped.Load() {
			return
		}
		r.close()
		a.tunnels.mu.Lock()
		if a.tunnels.running[id] == r {
			delete(a.tunnels.running, id)
		}
		a.tunnels.mu.Unlock()
		a.setTunnelStatus(TunnelStatus{ID: id, State: "error", Error: "SSH connection lost"})
		if t.AutoStart {
			a.retryTunnel(id)
		}
	}()
	return nil
}

func (a *App) retryTunnel(id string) {
	for delay := 2 * time.Second; ; delay = min(delay*2, time.Minute) {
		time.Sleep(delay)
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
	a.tunnels.mu.Unlock()
	for _, r := range all {
		r.close()
	}
}

func pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	a.Close()
	b.Close()
	<-done
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
		_, _ = io.ReadFull(c, b)
		host = net.IP(b).String()
	case 4:
		b := make([]byte, 16)
		_, _ = io.ReadFull(c, b)
		host = net.IP(b).String()
	case 3:
		l := make([]byte, 1)
		_, _ = io.ReadFull(c, l)
		b := make([]byte, l[0])
		_, _ = io.ReadFull(c, b)
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
	remote, err := dial("tcp", target)
	if err != nil {
		_, _ = c.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
		c.Close()
		return
	}
	_, _ = c.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
	_ = c.SetDeadline(time.Time{})
	pipe(c, remote)
}
