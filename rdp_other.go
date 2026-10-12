//go:build !windows

package main

import (
	"context"
	"errors"
)

// Remote Desktop needs the Windows RDP control.
type rdpEngine struct{}

func newRdpEngine(*App) *rdpEngine              { return &rdpEngine{} }
func (e *rdpEngine) stop()                      {}
func (e *rdpEngine) connectedSessions() int     { return 0 }
func (a *App) RdpAvailable() bool               { return false }
func (a *App) beforeClose(context.Context) bool { return false }

type ClassicMenuState struct {
	Supported bool `json:"supported"`
	Enabled   bool `json:"enabled"`
}

func (a *App) ClassicMenu() ClassicMenuState { return ClassicMenuState{} }
func (a *App) SetClassicMenu(bool) error     { return errors.New("Windows-only") }
func (a *App) RestartExplorer() error        { return errors.New("Windows-only") }

func (a *App) RdpCall(method, params string) (string, error) {
	return "", errors.New("Remote Desktop is only available on Windows")
}
