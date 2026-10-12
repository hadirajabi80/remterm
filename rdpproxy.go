package main

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/asn1"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Remote Desktop inside a tab without the Windows RDP control: the web
// component IronRDP (WebAssembly, in the page) speaks RDP itself, but a page
// can't open TCP connections. This is its relay: a WebSocket server on
// 127.0.0.1 that speaks Devolutions' RDCleanPath protocol —
//
//	page → relay   RDCleanPath request (destination, token, X.224 connection request)
//	relay → server TCP connect, X.224 request/response, TLS handshake
//	relay → page   RDCleanPath response (X.224 response, server certificate chain)
//	then           plain RDP bytes relayed between the WebSocket and the TLS stream
//
// The page authenticates (NLA/CredSSP) and renders; the relay only connects
// to destinations Remterm itself handed out a one-time token for.

const rdcleanpathVersion = 3390 // RDCleanPath BASE_VERSION (3389) + 1

// relayLog writes to REMTERM_RELAY_LOG when set (troubleshooting the in-tab RDP relay).
func relayLog(format string, args ...any) {
	path := os.Getenv("REMTERM_RELAY_LOG")
	if path == "" {
		return
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, time.Now().Format("15:04:05.000 ")+format+"\n", args...)
}

type rdcpError struct {
	ErrorCode    int `asn1:"explicit,tag:0"`
	HTTPStatus   int `asn1:"optional,explicit,tag:1"`
	WSALastError int `asn1:"optional,explicit,tag:2"`
	TLSAlert     int `asn1:"optional,explicit,tag:3"`
}

type rdcpPDU struct {
	Version          int64     `asn1:"explicit,tag:0"`
	Error            rdcpError `asn1:"optional,explicit,tag:1"`
	Destination      string    `asn1:"optional,explicit,tag:2,utf8"`
	ProxyAuth        string    `asn1:"optional,explicit,tag:3,utf8"`
	ServerAuth       string    `asn1:"optional,explicit,tag:4,utf8"`
	PreconnectionPDU string    `asn1:"optional,explicit,tag:5,utf8"`
	X224             []byte    `asn1:"optional,explicit,tag:6"`
	ServerCertChain  [][]byte  `asn1:"optional,explicit,tag:7"`
	ServerAddr       string    `asn1:"optional,explicit,tag:9,utf8"`
}

const (
	rdcpGeneralError     = 1
	rdcpNegotiationError = 2
)

type rdpGrant struct {
	dest    string
	expires time.Time
}

type rdpRelay struct {
	mu     sync.Mutex
	addr   string
	grants map[string]rdpGrant
}

// WebRdpSession is what the page needs to start an in-tab session.
type WebRdpSession struct {
	NeedsLogin  bool   `json:"needsLogin"` // no saved user name/password: the tab asks
	LoginUser   string `json:"loginUser"`  // user name to prefill in that form
	Mode        string `json:"mode"`       // "bastion" | "direct"
	Proxy       string `json:"proxy"`      // ws://127.0.0.1:<port>/rdp
	Token       string `json:"token"`
	Destination string `json:"destination"` // host:port
	Username    string `json:"username"`
	Password    string `json:"password"`
	Domain      string `json:"domain"`
}

// grant allows one connection to dest and returns the relay address and token.
func (r *rdpRelay) grant(dest string) (proxy, token string, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.addr == "" {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return "", "", fmt.Errorf("start the Remote Desktop relay: %w", err)
		}
		r.addr = ln.Addr().String()
		r.grants = map[string]rdpGrant{}
		mux := http.NewServeMux()
		mux.HandleFunc("/rdp", r.serve)
		go func() { _ = http.Serve(ln, mux) }()
	}
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	token = hex.EncodeToString(b)
	now := time.Now()
	for k, g := range r.grants {
		if now.After(g.expires) {
			delete(r.grants, k)
		}
	}
	r.grants[token] = rdpGrant{dest: dest, expires: now.Add(2 * time.Minute)}
	return "ws://" + r.addr + "/rdp", token, nil
}

func (r *rdpRelay) take(token, dest string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	g, ok := r.grants[token]
	delete(r.grants, token)
	return ok && time.Now().Before(g.expires) && strings.EqualFold(g.dest, dest)
}

var rdpUpgrader = websocket.Upgrader{
	ReadBufferSize:  1 << 16,
	WriteBufferSize: 1 << 16,
	// The page's origin differs per platform (wails://, http://wails.localhost);
	// access is controlled by the one-time token instead.
	CheckOrigin: func(*http.Request) bool { return true },
}

func (r *rdpRelay) serve(w http.ResponseWriter, req *http.Request) {
	ws, err := rdpUpgrader.Upgrade(w, req, nil)
	if err != nil {
		return
	}
	defer ws.Close()

	pdu, err := readRDCleanPath(ws)
	relayLog("request: err=%v dest=%q x224=%d bytes", err, func() string {
		if pdu != nil {
			return pdu.Destination
		}
		return ""
	}(), func() int {
		if pdu != nil {
			return len(pdu.X224)
		}
		return 0
	}())
	if err != nil {
		sendRDCleanPathError(ws, rdcpGeneralError, 400, nil)
		return
	}
	if pdu.Version != rdcleanpathVersion || pdu.Destination == "" || len(pdu.X224) == 0 {
		sendRDCleanPathError(ws, rdcpGeneralError, 400, nil)
		return
	}
	if !r.take(pdu.ProxyAuth, pdu.Destination) {
		sendRDCleanPathError(ws, rdcpGeneralError, 403, nil)
		return
	}

	tcp, err := net.DialTimeout("tcp", pdu.Destination, 15*time.Second)
	if err != nil {
		sendRDCleanPathError(ws, rdcpGeneralError, 502, nil)
		return
	}
	defer tcp.Close()
	_ = tcp.SetDeadline(time.Now().Add(30 * time.Second))

	// X.224 connection request / confirm, as sent by the page.
	if _, err := tcp.Write(pdu.X224); err != nil {
		sendRDCleanPathError(ws, rdcpGeneralError, 502, nil)
		return
	}
	confirm, err := readTPKT(tcp)
	relayLog("x224 confirm: err=%v % x", err, confirm)
	if err != nil {
		sendRDCleanPathError(ws, rdcpGeneralError, 502, nil)
		return
	}
	// TPKT(4) + X.224 CC(7) + RDP_NEG_RSP/FAILURE(8): type 0x02 response, 0x03 failure.
	var stream net.Conn = tcp
	var certs [][]byte
	if len(confirm) >= 19 && confirm[11] == 0x03 {
		sendRDCleanPathError(ws, rdcpNegotiationError, 0, confirm)
		return
	}
	selected := uint32(0)
	if len(confirm) >= 19 && confirm[11] == 0x02 {
		selected = binary.LittleEndian.Uint32(confirm[15:19])
	}
	if selected != 0 { // TLS, CredSSP (NLA) or RDSTLS: all start with TLS
		conf := &tls.Config{
			InsecureSkipVerify: true, // the page checks the certificate (CredSSP binds to its key); WALLIX uses self-signed ones
			MinVersion:         tls.VersionTLS10,
			MaxVersion:         tls.VersionTLS12,  // like mstsc: some RDP servers drop TLS 1.3 sessions
			CipherSuites:       allCipherSuites(), // older RDP servers still use RSA key exchange
		}
		tc := tls.Client(tcp, conf)
		err := tc.Handshake()
		relayLog("tls handshake (selected=%d): err=%v", selected, err)
		if err != nil {
			sendRDCleanPathError(ws, rdcpGeneralError, 502, nil)
			return
		}
		for _, c := range tc.ConnectionState().PeerCertificates {
			certs = append(certs, c.Raw)
		}
		stream = tc
	}
	_ = tcp.SetDeadline(time.Time{})

	res, err := asn1.Marshal(rdcpPDU{Version: rdcleanpathVersion, X224: confirm, ServerCertChain: certs, ServerAddr: tcp.RemoteAddr().String()})
	relayLog("response: %d bytes, %d certs, err=%v", len(res), len(certs), err)
	if err != nil || ws.WriteMessage(websocket.BinaryMessage, res) != nil {
		return
	}

	// Relay until either side closes.
	done := make(chan struct{}, 2)
	go func() {
		for {
			_, data, err := ws.ReadMessage()
			if err != nil {
				break
			}
			if _, err := stream.Write(data); err != nil {
				relayLog("page->server write: %v", err)
				break
			}
		}
		done <- struct{}{}
	}()
	go func() {
		buf := make([]byte, 64<<10)
		for {
			n, err := stream.Read(buf)
			if n > 0 && ws.WriteMessage(websocket.BinaryMessage, buf[:n]) != nil {
				break
			}
			if err != nil {
				relayLog("server->page: %v (after %d bytes)", err, n)
				break
			}
		}
		done <- struct{}{}
	}()
	<-done
	relayLog("relay closed")
}

// readRDCleanPath reads WebSocket messages until one complete DER PDU arrived.
func readRDCleanPath(ws *websocket.Conn) (*rdcpPDU, error) {
	_ = ws.SetReadDeadline(time.Now().Add(20 * time.Second))
	defer ws.SetReadDeadline(time.Time{})
	var buf []byte
	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			return nil, err
		}
		buf = append(buf, data...)
		if n, ok := derLength(buf); ok {
			if len(buf) < n {
				continue
			}
			var p rdcpPDU
			if _, err := asn1.Unmarshal(buf[:n], &p); err != nil {
				return nil, err
			}
			return &p, nil
		}
		if len(buf) > 1<<16 {
			return nil, errors.New("RDCleanPath request too large")
		}
	}
}

// derLength returns the total size of the DER element at the start of b.
func derLength(b []byte) (int, bool) {
	if len(b) < 2 {
		return 0, false
	}
	l := int(b[1])
	if l < 0x80 {
		return 2 + l, true
	}
	k := l & 0x7f
	if k == 0 || k > 4 || len(b) < 2+k {
		return 0, false
	}
	n := 0
	for i := 0; i < k; i++ {
		n = n<<8 | int(b[2+i])
	}
	return 2 + k + n, true
}

func readTPKT(r io.Reader) ([]byte, error) {
	h := make([]byte, 4)
	if _, err := io.ReadFull(r, h); err != nil {
		return nil, err
	}
	if h[0] != 3 {
		return nil, errors.New("not a TPKT packet")
	}
	n := int(binary.BigEndian.Uint16(h[2:4]))
	if n < 4 {
		return nil, errors.New("bad TPKT length")
	}
	body := make([]byte, n-4)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return append(h, body...), nil
}

func sendRDCleanPathError(ws *websocket.Conn, code, httpStatus int, x224 []byte) {
	b, err := asn1.Marshal(rdcpPDU{Version: rdcleanpathVersion, Error: rdcpError{ErrorCode: code, HTTPStatus: httpStatus}, X224: x224})
	if err == nil {
		_ = ws.WriteMessage(websocket.BinaryMessage, b)
	}
}

func allCipherSuites() []uint16 {
	var ids []uint16
	for _, s := range tls.CipherSuites() {
		ids = append(ids, s.ID)
	}
	for _, s := range tls.InsecureCipherSuites() {
		ids = append(ids, s.ID)
	}
	return ids
}

// splitDomain turns DOMAIN\user into (DOMAIN, user); other logins are kept whole.
func splitDomain(login string) (domain, user string) {
	if i := strings.Index(login, `\`); i > 0 && !strings.Contains(login, "@") {
		return login[:i], login[i+1:]
	}
	return "", login
}
