//go:build !windows

package main

import (
	"errors"
	"net"
	"os"
	"time"
)

func dialAgent() (net.Conn, error) {
	sock := os.Getenv("SSH_AUTH_SOCK")
	if sock == "" {
		return nil, errors.New("SSH_AUTH_SOCK not set")
	}
	return net.DialTimeout("unix", sock, 2*time.Second)
}
