//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/UserExistsError/conpty"
)

// LocalShell is a terminal program that can run on this machine.
type LocalShell struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Command string `json:"command"`
}

// ListShells returns the shells installed here, the preferred default first.
func (a *App) ListShells() []LocalShell {
	sysRoot := os.Getenv("SystemRoot")
	if sysRoot == "" {
		sysRoot = `C:\Windows`
	}
	sys32 := filepath.Join(sysRoot, "System32")
	var out []LocalShell

	if p := findExe("pwsh.exe", filepath.Join(os.Getenv("ProgramFiles"), "PowerShell", "7", "pwsh.exe")); p != "" {
		out = append(out, LocalShell{ID: "pwsh", Name: "PowerShell 7", Command: quote(p) + " -NoLogo"})
	}
	if p := filepath.Join(sys32, "WindowsPowerShell", "v1.0", "powershell.exe"); fileExists(p) {
		out = append(out, LocalShell{ID: "powershell", Name: "Windows PowerShell", Command: quote(p) + " -NoLogo"})
	}
	if p := filepath.Join(sys32, "cmd.exe"); fileExists(p) {
		out = append(out, LocalShell{ID: "cmd", Name: "Command Prompt", Command: quote(p)})
	}
	if p := filepath.Join(sys32, "wsl.exe"); fileExists(p) {
		out = append(out, LocalShell{ID: "wsl", Name: "WSL", Command: quote(p) + " --cd ~"})
	}
	if p := gitBash(); p != "" {
		out = append(out, LocalShell{ID: "gitbash", Name: "Git Bash", Command: quote(p) + " --login -i"})
	}
	return out
}

// LocalRequest starts a local shell; SessionID is chosen by the UI.
type LocalRequest struct {
	SessionID string `json:"sessionId"`
	ShellID   string `json:"shellId"`
	Cwd       string `json:"cwd"` // start folder; empty = home
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
}

func (a *App) OpenLocal(req LocalRequest) error {
	if req.SessionID == "" {
		return errors.New("missing session id")
	}
	if !conpty.IsConPtyAvailable() {
		return errors.New("local terminals need Windows 10 1809 or newer (ConPTY)")
	}
	var shell *LocalShell
	for _, s := range a.ListShells() {
		if s.ID == req.ShellID {
			shell = &s
			break
		}
	}
	if shell == nil {
		return fmt.Errorf("shell %q is not installed", req.ShellID)
	}

	dir, _ := os.UserHomeDir()
	command := shell.Command
	if req.Cwd != "" {
		if st, err := os.Stat(req.Cwd); err == nil && st.IsDir() {
			dir = req.Cwd
			if shell.ID == "wsl" {
				command = strings.TrimSuffix(command, " --cd ~") + " --cd " + quote(dir)
			}
		}
	}
	// CHERE_INVOKING keeps Git Bash's login profile from jumping to $HOME.
	env := append(os.Environ(), "TERM_PROGRAM=Remterm", "COLORTERM=truecolor", "CHERE_INVOKING=1")
	cols, rows := clamp(req.Cols, 20, 1000, 80), clamp(req.Rows, 5, 500, 24)
	cpty, err := conpty.Start(command,
		conpty.ConPtyDimensions(cols, rows),
		conpty.ConPtyWorkDir(dir),
		conpty.ConPtyEnv(env),
	)
	if err != nil {
		return fmt.Errorf("start %s: %w", shell.Name, err)
	}

	s := &Session{
		id:      req.SessionID,
		stdin:   cpty,
		resize:  cpty.Resize,
		closeFn: func() { _ = cpty.Close() },
		done:    make(chan struct{}),
	}
	title := shell.Name
	if req.Cwd != "" {
		title += " — " + req.Cwd
	}
	a.registerSession(s, "local:"+shell.ID, title)

	go a.pump(s, cpty)
	go func() {
		code, err := cpty.Wait(context.Background())
		if err != nil {
			a.closeSession(s, "Process ended", false, -1)
			return
		}
		a.closeSession(s, fmt.Sprintf("Process exited (code %d)", code), false, int(code))
	}()
	return nil
}

func findExe(name string, fallbacks ...string) string {
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	for _, f := range fallbacks {
		if fileExists(f) {
			return f
		}
	}
	return ""
}

func gitBash() string {
	candidates := []string{filepath.Join(os.Getenv("ProgramFiles"), "Git", "bin", "bash.exe")}
	if git, err := exec.LookPath("git.exe"); err == nil {
		// <Git>\cmd\git.exe → <Git>\bin\bash.exe
		candidates = append([]string{filepath.Join(filepath.Dir(filepath.Dir(git)), "bin", "bash.exe")}, candidates...)
	}
	for _, c := range candidates {
		if fileExists(c) {
			return c
		}
	}
	return ""
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func quote(p string) string {
	if strings.ContainsAny(p, " \t") {
		return `"` + p + `"`
	}
	return p
}
