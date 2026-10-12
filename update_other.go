//go:build !windows && !darwin

package main

import "errors"

func (a *App) installUpdate(string) error {
	return errors.New("automatic updates are available on Windows and macOS")
}
