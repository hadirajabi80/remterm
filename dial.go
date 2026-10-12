package main

import (
	"bufio"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/net/proxy"
)

// sshConn is a connected SSH client plus the jump hosts it goes through.
type sshConn struct {
	client  *ssh.Client
	hops    []*ssh.Client // outermost first
	host    Host          // effective settings (groups applied)
	forward agent.Agent   // keys offered to the server when agent forwarding is on
	closers []func()
}

func (c *sshConn) Close() {
	if c.client != nil {
		c.client.Close()
	}
	for i := len(c.hops) - 1; i >= 0; i-- {
		c.hops[i].Close()
	}
	for _, f := range c.closers {
		f()
	}
}

// connectHost connects to h through its proxy and jump-host chain (jump
// hosts may have jump hosts of their own). password is what the user typed
// for h; saved secrets are used otherwise. Jump hosts use saved credentials.
func (a *App) connectHost(h Host, password string, seen map[string]bool) (*sshConn, error) {
	if seen == nil {
		seen = map[string]bool{}
	}
	if h.ID != "" {
		if seen[h.ID] {
			return nil, fmt.Errorf("host chain loops back to %s", h.Name)
		}
		seen[h.ID] = true
	}
	if len(seen) > 8 {
		return nil, errors.New("host chain is longer than 8 hops")
	}
	h = a.effectiveHost(h)

	secret := password
	if secret == "" {
		secret = a.savedSecret(h)
	}
	cfg, auth, err := a.clientConfig(h, secret)
	if err != nil {
		return nil, err
	}
	addr := hostAddr(h)
	cfg.HostKeyAlgorithms = hostKeyAlgorithms(addr)
	conn := &sshConn{host: h, forward: auth.forward, closers: auth.closers}

	var raw net.Conn
	if h.JumpHostID != "" {
		jh, ok := a.store.Host(h.JumpHostID)
		if !ok {
			conn.Close()
			return nil, errors.New("jump host no longer exists — edit this host")
		}
		jc, err := a.connectHost(jh, "", seen)
		if err != nil {
			conn.Close()
			return nil, fmt.Errorf("jump host %s: %s", jh.Name, cleanAuthMarker(err))
		}
		conn.hops = append(append(conn.hops, jc.hops...), jc.client)
		conn.closers = append(conn.closers, jc.closers...)
		if raw, err = jc.client.Dial("tcp", addr); err != nil {
			conn.Close()
			return nil, fmt.Errorf("jump host %s cannot reach %s: %w", jh.Name, addr, err)
		}
	} else {
		if raw, err = a.dialFirstHop(h, addr); err != nil {
			conn.Close()
			return nil, err
		}
		_ = raw.SetDeadline(time.Now().Add(30 * time.Second)) // handshake budget
	}

	c, chans, reqs, err := ssh.NewClientConn(raw, addr, cfg)
	if err != nil {
		raw.Close()
		conn.Close()
		return nil, wrapDialErr(err)
	}
	_ = raw.SetDeadline(time.Time{})
	conn.client = ssh.NewClient(c, chans, reqs)
	return conn, nil
}

func cleanAuthMarker(err error) string {
	s := err.Error()
	for _, m := range []string{errAuthFailed + ": ", errPassphraseRequired + ": "} {
		s = strings.TrimPrefix(s, m)
	}
	return s
}

// savedSecret is the stored password for a host, or its identity's.
func (a *App) savedSecret(h Host) string {
	if h.HasSecret {
		if s, err := getSecret(h.ID); err == nil && s != "" {
			return s
		}
	}
	if h.IdentityID != "" {
		return getNamedSecret("identity:" + h.IdentityID)
	}
	return ""
}

// dialFirstHop opens the TCP connection to the first SSH server, directly
// or through the host's SOCKS5 / HTTP proxy.
func (a *App) dialFirstHop(h Host, addr string) (net.Conn, error) {
	d := &net.Dialer{Timeout: 15 * time.Second}
	p := h.Proxy
	if p == nil || p.Host == "" {
		return d.Dial("tcp", addr)
	}
	pass := ""
	if p.HasSecret && h.ProxySecretKey != "" {
		pass = getNamedSecret(h.ProxySecretKey)
	}
	paddr := net.JoinHostPort(p.Host, strconv.Itoa(p.Port))
	switch p.Type {
	case "http":
		return dialHTTPConnect(d, paddr, addr, p.User, pass)
	default:
		var auth *proxy.Auth
		if p.User != "" {
			auth = &proxy.Auth{User: p.User, Password: pass}
		}
		dialer, err := proxy.SOCKS5("tcp", paddr, auth, d)
		if err != nil {
			return nil, err
		}
		c, err := dialer.Dial("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("SOCKS5 proxy %s: %w", paddr, err)
		}
		return c, nil
	}
}

// bufConn keeps bytes the HTTP proxy reply reader already buffered (the
// SSH server banner may arrive in the same packet).
type bufConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufConn) Read(p []byte) (int, error) { return b.r.Read(p) }

func dialHTTPConnect(d *net.Dialer, proxyAddr, target, user, pass string) (net.Conn, error) {
	c, err := d.Dial("tcp", proxyAddr)
	if err != nil {
		return nil, fmt.Errorf("HTTP proxy %s: %w", proxyAddr, err)
	}
	req := "CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n"
	if user != "" {
		req += "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass)) + "\r\n"
	}
	_ = c.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err := c.Write([]byte(req + "\r\n")); err != nil {
		c.Close()
		return nil, err
	}
	r := bufio.NewReader(c)
	resp, err := http.ReadResponse(r, &http.Request{Method: http.MethodConnect})
	if err != nil {
		c.Close()
		return nil, fmt.Errorf("HTTP proxy %s: %w", proxyAddr, err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		c.Close()
		return nil, fmt.Errorf("HTTP proxy %s refused: %s", proxyAddr, resp.Status)
	}
	_ = c.SetDeadline(time.Time{})
	return &bufConn{Conn: c, r: r}, nil
}

type authState struct {
	forward agent.Agent
	closers []func()
}

// clientConfig builds the auth chain for a host (groups already applied):
//
//	keys:     identity key, host keychain key, host key file, else ~/.ssh defaults
//	agent:    the Windows OpenSSH agent (auto)
//	password: host / identity password, also answers keyboard-interactive
//
// AuthMethod "key" or "password" restricts to that kind.
func (a *App) clientConfig(h Host, secret string) (*ssh.ClientConfig, authState, error) {
	var st authState
	method := h.AuthMethod
	if method == "" {
		method = "auto"
	}
	username := h.User
	var ident Identity
	if h.IdentityID != "" {
		if i, ok := find(a.ListIdentities(), h.IdentityID, identityID); ok {
			ident = i
			username = i.Username
		}
	}
	if username == "" {
		username = defaultUser()
	}

	var methods []ssh.AuthMethod
	var signers []ssh.Signer
	var rawKeys []any // for agent forwarding without an OS agent
	addKeychain := func(id string) error {
		s, err := a.keychainSigner(id, secret)
		if err != nil {
			return err
		}
		signers = append(signers, s)
		if raw, err := a.keychainRawKey(id, secret); err == nil {
			rawKeys = append(rawKeys, raw)
		}
		return nil
	}
	if method != "password" {
		if ident.KeyID != "" {
			if err := addKeychain(ident.KeyID); err != nil {
				return nil, st, err
			}
		}
		if h.KeyID != "" {
			if err := addKeychain(h.KeyID); err != nil {
				return nil, st, err
			}
		}
		if h.KeyPath != "" {
			s, raw, err := loadKeyFile(expandPath(h.KeyPath), secret)
			if err != nil {
				return nil, st, err
			}
			signers = append(signers, s)
			rawKeys = append(rawKeys, raw)
		}
		if len(signers) == 0 {
			for _, p := range defaultKeyPaths() {
				if s, raw, err := loadKeyFile(p, secret); err == nil {
					signers = append(signers, s)
					rawKeys = append(rawKeys, raw)
				}
			}
		}

		var osAgent agent.ExtendedAgent
		if method == "auto" || h.AgentForwarding {
			if conn, err := dialAgent(); err == nil {
				osAgent = agent.NewClient(conn)
				st.closers = append(st.closers, func() { conn.Close() })
			}
		}
		if method == "key" && len(signers) == 0 && osAgent == nil {
			return nil, st, errors.New("no private key found — pick a key from the keychain in host settings")
		}
		useAgent := method == "auto" && osAgent != nil
		methods = append(methods, ssh.PublicKeysCallback(func() ([]ssh.Signer, error) {
			all := append([]ssh.Signer(nil), signers...)
			if useAgent {
				if as, err := osAgent.Signers(); err == nil {
					all = append(all, as...)
				}
			}
			return all, nil
		}))

		if h.AgentForwarding {
			if osAgent != nil {
				st.forward = osAgent
			} else {
				kr := agent.NewKeyring()
				for _, k := range rawKeys {
					_ = kr.Add(agent.AddedKey{PrivateKey: k})
				}
				st.forward = kr
			}
		}
	}

	if method != "key" {
		if secret != "" {
			methods = append(methods,
				ssh.Password(secret),
				ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
					answers := make([]string, len(questions))
					for i := range answers {
						answers[i] = secret
					}
					return answers, nil
				}),
			)
		} else if method == "password" {
			return nil, st, errors.New(errAuthFailed + ": password required")
		}
	}

	return &ssh.ClientConfig{
		User:            username,
		Auth:            methods,
		HostKeyCallback: a.hostKeyCallback(),
		Timeout:         15 * time.Second,
	}, st, nil
}

func (a *App) keychainRawKey(id, passphrase string) (any, error) {
	path, err := keyFile(id)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if p := getNamedSecret("key:" + id); p != "" {
		passphrase = p
	}
	raw, err := ssh.ParseRawPrivateKey(data)
	var missing *ssh.PassphraseMissingError
	if errors.As(err, &missing) {
		return ssh.ParseRawPrivateKeyWithPassphrase(data, []byte(passphrase))
	}
	return raw, err
}

func loadKeyFile(path, passphrase string) (ssh.Signer, any, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("read key %s: %w", path, err)
	}
	raw, err := ssh.ParseRawPrivateKey(b)
	var missing *ssh.PassphraseMissingError
	if errors.As(err, &missing) {
		if passphrase == "" {
			return nil, nil, fmt.Errorf("%s: key %s is encrypted", errPassphraseRequired, filepath.Base(path))
		}
		if raw, err = ssh.ParseRawPrivateKeyWithPassphrase(b, []byte(passphrase)); err != nil {
			return nil, nil, fmt.Errorf("%s: wrong passphrase for key %s", errPassphraseRequired, filepath.Base(path))
		}
	}
	if err != nil {
		return nil, nil, fmt.Errorf("parse key %s: %w", filepath.Base(path), err)
	}
	s, err := ssh.NewSignerFromKey(raw)
	return s, raw, err
}

func wrapDialErr(err error) error {
	if err == nil {
		return nil
	}
	if strings.Contains(err.Error(), "unable to authenticate") {
		return errors.New(errAuthFailed + ": authentication failed")
	}
	return err
}
