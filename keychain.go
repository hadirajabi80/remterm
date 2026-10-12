package main

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

func keysDir() (string, error) {
	d, err := dataDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(d, "keys")
	return dir, os.MkdirAll(dir, 0o700)
}

func keyFile(id string) (string, error) {
	dir, err := keysDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, id), nil
}

func (a *App) ListKeys() []KeyItem {
	var out []KeyItem
	a.store.read(func(d *storeData) { out = append(out, d.Keys...) })
	return out
}

type GenerateKeyRequest struct {
	Label          string `json:"label"`
	Type           string `json:"type"` // "ed25519" | "ecdsa" | "rsa"
	Bits           int    `json:"bits"` // ecdsa 256/384/521, rsa 2048/3072/4096
	Passphrase     string `json:"passphrase"`
	SavePassphrase bool   `json:"savePassphrase"`
}

func (a *App) GenerateKey(req GenerateKeyRequest) (KeyItem, error) {
	var priv crypto.PrivateKey
	switch req.Type {
	case "", "ed25519":
		_, k, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return KeyItem{}, err
		}
		priv = k
	case "ecdsa":
		curve := map[int]elliptic.Curve{256: elliptic.P256(), 384: elliptic.P384(), 521: elliptic.P521()}[req.Bits]
		if curve == nil {
			curve = elliptic.P256()
		}
		k, err := ecdsa.GenerateKey(curve, rand.Reader)
		if err != nil {
			return KeyItem{}, err
		}
		priv = k
	case "rsa":
		bits := req.Bits
		if bits < 2048 {
			bits = 4096
		}
		k, err := rsa.GenerateKey(rand.Reader, bits)
		if err != nil {
			return KeyItem{}, err
		}
		priv = k
	default:
		return KeyItem{}, fmt.Errorf("unknown key type %q", req.Type)
	}

	label := strings.TrimSpace(req.Label)
	if label == "" {
		label = "termora-" + time.Now().Format("2006-01-02")
	}
	var block *pem.Block
	var err error
	if req.Passphrase != "" {
		block, err = ssh.MarshalPrivateKeyWithPassphrase(priv, label, []byte(req.Passphrase))
	} else {
		block, err = ssh.MarshalPrivateKey(priv, label)
	}
	if err != nil {
		return KeyItem{}, err
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return KeyItem{}, err
	}
	return a.storeKey(label, pem.EncodeToMemory(block), signer.PublicKey(), req.Passphrase, req.SavePassphrase)
}

type ImportKeyRequest struct {
	Label          string `json:"label"`
	PrivateKey     string `json:"privateKey"` // pasted PEM, or…
	Path           string `json:"path"`       // …a file to read
	Passphrase     string `json:"passphrase"`
	SavePassphrase bool   `json:"savePassphrase"`
}

func (a *App) ImportKey(req ImportKeyRequest) (KeyItem, error) {
	data := []byte(strings.TrimSpace(req.PrivateKey) + "\n")
	label := strings.TrimSpace(req.Label)
	if req.Path != "" {
		b, err := os.ReadFile(expandPath(req.Path))
		if err != nil {
			return KeyItem{}, err
		}
		data = b
		if label == "" {
			label = filepath.Base(req.Path)
		}
	}
	var signer ssh.Signer
	raw, err := ssh.ParseRawPrivateKey(data)
	var missing *ssh.PassphraseMissingError
	switch {
	case errors.As(err, &missing):
		if req.Passphrase == "" {
			return KeyItem{}, errors.New(errPassphraseRequired + ": this key is protected — enter its passphrase")
		}
		raw, err = ssh.ParseRawPrivateKeyWithPassphrase(data, []byte(req.Passphrase))
		if err != nil {
			return KeyItem{}, errors.New("wrong passphrase")
		}
	case err != nil:
		return KeyItem{}, fmt.Errorf("not a private key: %w", err)
	}
	if signer, err = ssh.NewSignerFromKey(raw); err != nil {
		return KeyItem{}, err
	}
	if label == "" {
		label = "imported-" + time.Now().Format("2006-01-02")
	}
	pass := ""
	if missing != nil {
		pass = req.Passphrase
	}
	return a.storeKey(label, data, signer.PublicKey(), pass, req.SavePassphrase)
}

func (a *App) storeKey(label string, pemData []byte, pub ssh.PublicKey, passphrase string, save bool) (KeyItem, error) {
	k := KeyItem{
		ID:          newID(),
		Label:       label,
		Type:        pub.Type(),
		PublicKey:   strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub))) + " " + strings.ReplaceAll(label, " ", "_"),
		Fingerprint: ssh.FingerprintSHA256(pub),
		Encrypted:   passphrase != "",
		Created:     time.Now().UnixMilli(),
	}
	path, err := keyFile(k.ID)
	if err != nil {
		return k, err
	}
	if err := os.WriteFile(path, pemData, 0o600); err != nil {
		return k, err
	}
	if passphrase != "" && save {
		if err := setNamedSecret("key:"+k.ID, passphrase); err == nil {
			k.HasPassphrase = true
		}
	}
	return k, a.store.withLock(func(d *storeData) { d.Keys = append(d.Keys, k) })
}

// UpdateKey renames a key and/or attaches an OpenSSH certificate ("" removes it).
func (a *App) UpdateKey(id, label, certificate string) (KeyItem, error) {
	k, ok := find(a.ListKeys(), id, keyID)
	if !ok {
		return k, errors.New("key not found")
	}
	if l := strings.TrimSpace(label); l != "" {
		k.Label = l
	}
	certificate = strings.TrimSpace(certificate)
	if certificate != "" {
		pub, _, _, _, err := ssh.ParseAuthorizedKey([]byte(certificate))
		if err != nil {
			return k, fmt.Errorf("not an OpenSSH certificate: %w", err)
		}
		cert, ok := pub.(*ssh.Certificate)
		if !ok {
			return k, errors.New("that is a public key, not a certificate (…-cert-v01@openssh.com)")
		}
		if ssh.FingerprintSHA256(cert.Key) != k.Fingerprint {
			return k, errors.New("this certificate belongs to a different key")
		}
	}
	k.Certificate = certificate
	return k, a.store.withLock(func(d *storeData) { d.Keys = upsert(d.Keys, k, keyID) })
}

func (a *App) SetKeyPassphrase(id, passphrase string) error {
	if passphrase == "" {
		deleteNamedSecret("key:" + id)
	} else if err := setNamedSecret("key:"+id, passphrase); err != nil {
		return err
	}
	return a.store.withLock(func(d *storeData) {
		for i := range d.Keys {
			if d.Keys[i].ID == id {
				d.Keys[i].HasPassphrase = passphrase != ""
			}
		}
	})
}

func (a *App) DeleteKey(id string) error {
	if path, err := keyFile(id); err == nil {
		_ = os.Remove(path)
	}
	deleteNamedSecret("key:" + id)
	return a.store.withLock(func(d *storeData) {
		d.Keys = without(d.Keys, id, keyID)
		for i := range d.Hosts {
			if d.Hosts[i].KeyID == id {
				d.Hosts[i].KeyID = ""
			}
		}
		for i := range d.Identities {
			if d.Identities[i].KeyID == id {
				d.Identities[i].KeyID = ""
			}
		}
	})
}

// keychainSigner loads a stored key (with its certificate, if any).
func (a *App) keychainSigner(id, passphrase string) (ssh.Signer, error) {
	k, ok := find(a.ListKeys(), id, keyID)
	if !ok {
		return nil, errors.New("the key linked to this host was deleted from the keychain")
	}
	path, err := keyFile(id)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if k.Encrypted {
		if p := getNamedSecret("key:" + id); p != "" {
			passphrase = p
		}
	}
	var signer ssh.Signer
	if k.Encrypted {
		if passphrase == "" {
			return nil, fmt.Errorf("%s: key %q is encrypted", errPassphraseRequired, k.Label)
		}
		signer, err = ssh.ParsePrivateKeyWithPassphrase(data, []byte(passphrase))
		if err != nil {
			return nil, fmt.Errorf("%s: wrong passphrase for key %q", errPassphraseRequired, k.Label)
		}
	} else if signer, err = ssh.ParsePrivateKey(data); err != nil {
		return nil, err
	}
	if k.Certificate != "" {
		pub, _, _, _, err := ssh.ParseAuthorizedKey([]byte(k.Certificate))
		if err == nil {
			if cert, ok := pub.(*ssh.Certificate); ok {
				if cs, err := ssh.NewCertSigner(cert, signer); err == nil {
					return cs, nil
				}
			}
		}
	}
	return signer, nil
}

type ExportKeyRequest struct {
	KeyID    string `json:"keyId"`
	HostID   string `json:"hostId"`
	Password string `json:"password"` // when the host has no saved credentials
	Path     string `json:"path"`     // authorized_keys location, default ~/.ssh/authorized_keys
}

// ExportKeyToHost appends the public key to the host's authorized_keys
// (once) and links the key to the host.
func (a *App) ExportKeyToHost(req ExportKeyRequest) error {
	k, ok := find(a.ListKeys(), req.KeyID, keyID)
	if !ok {
		return errors.New("key not found")
	}
	h, ok := a.store.Host(req.HostID)
	if !ok {
		return errors.New("host not found")
	}
	conn, err := a.connectHost(h, req.Password, nil)
	if err != nil {
		return err
	}
	defer conn.Close()

	path := strings.TrimSpace(req.Path)
	if path == "" {
		path = "~/.ssh/authorized_keys"
	}
	path = strings.Replace(path, "~", "$HOME", 1)
	q := func(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
	script := fmt.Sprintf(`set -e; f=%s; d=$(dirname "$f"); mkdir -p "$d"; chmod 700 "$d"; touch "$f"; chmod 600 "$f"; `+
		`grep -qxF %s "$f" || echo %s >> "$f"`, `"`+path+`"`, q(k.PublicKey), q(k.PublicKey))

	sess, err := conn.client.NewSession()
	if err != nil {
		return err
	}
	defer sess.Close()
	if out, err := sess.CombinedOutput(script); err != nil {
		return fmt.Errorf("could not update authorized_keys: %v %s", err, strings.TrimSpace(string(out)))
	}
	return a.store.withLock(func(d *storeData) {
		for i := range d.Hosts {
			if d.Hosts[i].ID == h.ID {
				d.Hosts[i].KeyID = k.ID
			}
		}
	})
}
