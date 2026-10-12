//go:build windows

package main

import (
	"os/exec"
	"syscall"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows"
)

// installUpdate runs the downloaded setup silently; it replaces the files
// (running ones are moved aside), then starts the new Remterm (/run).
func (a *App) installUpdate(setup string) error {
	cmd := exec.Command(setup, "/S", "/run")
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
	if err := cmd.Start(); err != nil {
		return err
	}
	a.rdp.stop()
	wruntime.Quit(a.ctx)
	return nil
}
