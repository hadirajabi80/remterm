//go:build !windows

package main

import "errors"

type LocalShell struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Command string `json:"command"`
}

type LocalRequest struct {
	SessionID string `json:"sessionId"`
	ShellID   string `json:"shellId"`
	Cwd       string `json:"cwd"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
}

func (a *App) ListShells() []LocalShell { return nil }

func (a *App) OpenLocal(LocalRequest) error {
	return errors.New("local terminals are only implemented on Windows")
}

func handleCommandLine([]string) bool { return false }

func (a *App) ExplorerMenuEnabled() bool { return false }

func (a *App) SetExplorerMenu(bool) error {
	return errors.New("the Explorer menu is Windows-only")
}
