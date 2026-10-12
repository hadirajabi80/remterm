package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial"
)

// ---------------- Telnet ----------------

const (
	tnIAC  = 255
	tnDONT = 254
	tnDO   = 253
	tnWONT = 252
	tnWILL = 251
	tnSB   = 250
	tnSE   = 240

	optEcho  = 1
	optSGA   = 3
	optTType = 24
	optNAWS  = 31
)

// telnetConn speaks just enough Telnet for interactive logins: it agrees
// to server echo, suppress-go-ahead, terminal type and window size, and
// refuses everything else.
type telnetConn struct {
	c          net.Conn
	mu         sync.Mutex
	cols, rows int
	naws       bool
}

func (t *telnetConn) send(b []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	_, err := t.c.Write(b)
	return err
}

func (t *telnetConn) Write(p []byte) (int, error) {
	out := make([]byte, 0, len(p)+8)
	for _, b := range p {
		switch b {
		case tnIAC:
			out = append(out, tnIAC, tnIAC)
		case '\r':
			out = append(out, '\r', '\n')
		default:
			out = append(out, b)
		}
	}
	return len(p), t.send(out)
}

func (t *telnetConn) sendNAWS() error {
	t.mu.Lock()
	cols, rows := t.cols, t.rows
	t.mu.Unlock()
	return t.send([]byte{tnIAC, tnSB, optNAWS, byte(cols >> 8), byte(cols), byte(rows >> 8), byte(rows), tnIAC, tnSE})
}

func (t *telnetConn) resize(cols, rows int) error {
	t.mu.Lock()
	t.cols, t.rows = cols, rows
	on := t.naws
	t.mu.Unlock()
	if on {
		return t.sendNAWS()
	}
	return nil
}

// telnetReader strips Telnet commands from the stream and answers them.
type telnetReader struct {
	t     *telnetConn
	buf   []byte
	state int // 0 data, 1 IAC, 2 option verb, 3 SB, 4 SB IAC
	verb  byte
	sb    []byte
}

func (r *telnetReader) Read(p []byte) (int, error) {
	for {
		n, err := r.t.c.Read(r.buf)
		out := p[:0]
		for _, b := range r.buf[:n] {
			switch r.state {
			case 0:
				if b == tnIAC {
					r.state = 1
				} else {
					out = append(out, b)
				}
			case 1:
				switch b {
				case tnIAC:
					out = append(out, tnIAC)
					r.state = 0
				case tnDO, tnDONT, tnWILL, tnWONT:
					r.verb, r.state = b, 2
				case tnSB:
					r.sb, r.state = r.sb[:0], 3
				default:
					r.state = 0
				}
			case 2:
				r.answer(r.verb, b)
				r.state = 0
			case 3:
				if b == tnIAC {
					r.state = 4
				} else {
					r.sb = append(r.sb, b)
				}
			case 4:
				if b == tnSE {
					r.subnegotiation()
					r.state = 0
				} else {
					r.sb = append(r.sb, b)
					r.state = 3
				}
			}
		}
		if len(out) > 0 || err != nil {
			return len(out), err
		}
	}
}

func (r *telnetReader) answer(verb, opt byte) {
	t := r.t
	switch verb {
	case tnDO:
		switch opt {
		case optNAWS:
			t.mu.Lock()
			t.naws = true
			t.mu.Unlock()
			_ = t.send([]byte{tnIAC, tnWILL, optNAWS})
			_ = t.sendNAWS()
		case optTType, optSGA:
			_ = t.send([]byte{tnIAC, tnWILL, opt})
		default:
			_ = t.send([]byte{tnIAC, tnWONT, opt})
		}
	case tnWILL:
		if opt == optEcho || opt == optSGA {
			_ = t.send([]byte{tnIAC, tnDO, opt})
		} else {
			_ = t.send([]byte{tnIAC, tnDONT, opt})
		}
	}
}

func (r *telnetReader) subnegotiation() {
	if len(r.sb) >= 2 && r.sb[0] == optTType && r.sb[1] == 1 { // SEND
		msg := append([]byte{tnIAC, tnSB, optTType, 0}, []byte("XTERM-256COLOR")...)
		_ = r.t.send(append(msg, tnIAC, tnSE))
	}
}

func (a *App) openTelnet(req ConnectRequest, h Host) error {
	port := h.Port
	if port == 0 || port == 22 {
		port = 23
	}
	addr := net.JoinHostPort(h.Address, strconv.Itoa(port))
	c, err := net.DialTimeout("tcp", addr, 15*time.Second)
	if err != nil {
		return err
	}
	t := &telnetConn{c: c, cols: clamp(req.Cols, 20, 1000, 80), rows: clamp(req.Rows, 5, 500, 24)}
	s := &Session{id: req.SessionID, stdin: t, resize: t.resize, closeFn: func() { c.Close() }, done: make(chan struct{})}
	a.registerSession(s, "ssh:"+h.ID, h.Name)

	password := req.Password
	if password == "" {
		password = a.savedSecret(h)
	}
	r := &telnetReader{t: t, buf: make([]byte, 16*1024)}
	go func() {
		a.pump(s, &telnetLogin{r: r, w: t, user: h.User, password: password})
		a.closeSession(s, "Connection closed", false, -1)
	}()
	_ = a.rememberConnection(h, req.Password, req.SavePassword)
	return nil
}

// telnetLogin answers the first "login:" and "password:" prompts with the
// host's saved username and password.
type telnetLogin struct {
	r              io.Reader
	w              io.Writer
	user, password string
	tail           string
	sentUser       bool
	sentPass       bool
}

func (l *telnetLogin) Read(p []byte) (int, error) {
	n, err := l.r.Read(p)
	if n > 0 && (!l.sentUser || !l.sentPass) {
		l.tail = strings.ToLower(l.tail + string(p[:n]))
		if len(l.tail) > 200 {
			l.tail = l.tail[len(l.tail)-200:]
		}
		t := strings.TrimRight(l.tail, " ")
		switch {
		case !l.sentUser && l.user != "" && (strings.HasSuffix(t, "login:") || strings.HasSuffix(t, "username:")):
			l.sentUser, l.tail = true, ""
			_, _ = l.w.Write([]byte(l.user + "\r"))
		case !l.sentPass && l.password != "" && strings.HasSuffix(t, "password:"):
			l.sentPass, l.sentUser, l.tail = true, true, ""
			_, _ = l.w.Write([]byte(l.password + "\r"))
		}
	}
	return n, err
}

// ---------------- Serial ----------------

func (a *App) ListSerialPorts() []string {
	ports, _ := serial.GetPortsList()
	return ports
}

func (a *App) openSerial(req ConnectRequest, h Host) error {
	cfg := h.Serial
	if cfg == nil || cfg.Port == "" {
		return errors.New("choose a serial port in the host settings")
	}
	mode := &serial.Mode{BaudRate: cfg.Baud, DataBits: cfg.DataBits}
	if mode.BaudRate == 0 {
		mode.BaudRate = 9600
	}
	if mode.DataBits == 0 {
		mode.DataBits = 8
	}
	mode.Parity = map[string]serial.Parity{"odd": serial.OddParity, "even": serial.EvenParity, "mark": serial.MarkParity, "space": serial.SpaceParity}[cfg.Parity]
	mode.StopBits = map[string]serial.StopBits{"1.5": serial.OnePointFiveStopBits, "2": serial.TwoStopBits}[cfg.StopBits]
	p, err := serial.Open(cfg.Port, mode)
	if err != nil {
		return fmt.Errorf("open %s: %w", cfg.Port, err)
	}
	if cfg.FlowControl == "rts/cts" {
		_ = p.SetRTS(true)
	}
	s := &Session{id: req.SessionID, stdin: p, resize: func(int, int) error { return nil }, closeFn: func() { p.Close() }, done: make(chan struct{})}
	a.registerSession(s, "ssh:"+h.ID, h.Name)
	go func() {
		a.pump(s, p)
		a.closeSession(s, "Serial port closed", false, -1)
	}()
	_ = a.rememberConnection(h, "", false)
	return nil
}
