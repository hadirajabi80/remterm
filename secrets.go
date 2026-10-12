package main

import "github.com/zalando/go-keyring"

// Passwords and key passphrases are stored in the OS credential store
// (Windows Credential Manager, macOS Keychain, Secret Service on Linux).
const keyringService = "Termora"

func setSecret(hostID, secret string) error {
	return keyring.Set(keyringService, "host:"+hostID, secret)
}

func getSecret(hostID string) (string, error) {
	return keyring.Get(keyringService, "host:"+hostID)
}

func deleteSecret(hostID string) {
	_ = keyring.Delete(keyringService, "host:"+hostID)
}
