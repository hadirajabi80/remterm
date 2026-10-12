package main

import "github.com/zalando/go-keyring"

// Passwords and key passphrases are stored in the OS credential store
// (Windows Credential Manager, macOS Keychain, Secret Service on Linux).
const keyringService = "Remterm"

// Secrets saved by Termora (Remterm's SSH half before the merge) are read
// from there once and moved to Remterm's own entries.
const legacyKeyringService = "Termora"

func setSecret(hostID, secret string) error {
	return keyring.Set(keyringService, "host:"+hostID, secret)
}

func getSecret(hostID string) (string, error) {
	return getKeyring("host:" + hostID)
}

func deleteSecret(hostID string) {
	_ = keyring.Delete(keyringService, "host:"+hostID)
	_ = keyring.Delete(legacyKeyringService, "host:"+hostID)
}

// Named secrets: "identity:<id>", "key:<id>", "proxy:<hostId>", "proxy:group:<path>".
func setNamedSecret(name, secret string) error { return keyring.Set(keyringService, name, secret) }

func getNamedSecret(name string) string {
	v, _ := getKeyring(name)
	return v
}

func deleteNamedSecret(name string) {
	_ = keyring.Delete(keyringService, name)
	_ = keyring.Delete(legacyKeyringService, name)
}

func getKeyring(name string) (string, error) {
	v, err := keyring.Get(keyringService, name)
	if err == nil {
		return v, nil
	}
	old, oldErr := keyring.Get(legacyKeyringService, name)
	if oldErr != nil {
		return "", err
	}
	if keyring.Set(keyringService, name, old) == nil {
		_ = keyring.Delete(legacyKeyringService, name)
	}
	return old, nil
}
