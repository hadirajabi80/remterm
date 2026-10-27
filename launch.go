package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/options"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Command line:
//
//	Remterm.exe [--cwd <folder or file>]   open a local terminal there
//	Remterm.exe <folder>                   same (what Explorer drag-onto-exe passes)
//	Remterm.exe --install-context-menu     add "Open in Remterm" to Explorer, then exit
//	Remterm.exe --uninstall-context-menu   remove it, then exit
//	Remterm.exe --uninstall                uninstall a per-user installation, then exit

// cwdFromArgs returns the folder to open, or "" when none was given. A file
// path opens its containing folder.
func cwdFromArgs(args []string) string {
	var p string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--cwd" && i+1 < len(args):
			p = args[i+1]
			i++
		case strings.HasPrefix(a, "--cwd="):
			p = strings.TrimPrefix(a, "--cwd=")
		case !strings.HasPrefix(a, "-") && p == "":
			p = a
		}
	}
	p = strings.Trim(strings.TrimSpace(p), `"`)
	if p == "" {
		return ""
	}
	if len(p) == 2 && p[1] == ':' && (p[0]|0x20 >= 'a' && p[0]|0x20 <= 'z') {
		p += `\` // `--cwd "C:\"` arrives as `C:"`; bare "C:" would be that drive's current folder
	}
	st, err := os.Stat(p)
	if err != nil {
		return ""
	}
	if !st.IsDir() {
		p = filepath.Dir(p)
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	return abs
}

// launchState hands the folder from the command line to the UI exactly once.
type launchState struct {
	mu  sync.Mutex
	cwd string
}

func (l *launchState) take() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	c := l.cwd
	l.cwd = ""
	return c
}

// TakeLaunchFolder returns the folder Remterm was started for ("" if none).
func (a *App) TakeLaunchFolder() string {
	return a.launch.take()
}

// onFileOpen (macOS) opens a terminal in a folder handed over by Finder:
// dropped on the Dock icon or sent by the "Open in Remterm" Quick Action.
func (a *App) onFileOpen(path string) {
	cwd := cwdFromArgs([]string{path})
	if cwd == "" {
		return
	}
	if a.ctx == nil {
		a.launch.mu.Lock()
		a.launch.cwd = cwd // the UI picks it up when it starts
		a.launch.mu.Unlock()
		return
	}
	a.emit("launch:open", cwd)
}

// onSecondInstance runs in the first instance when Remterm is started again
// (e.g. "Open in Remterm" while it is already open): open a tab there and
// bring the window forward instead of starting a second window.
func (a *App) onSecondInstance(data options.SecondInstanceData) {
	if a.ctx == nil {
		return
	}
	wruntime.WindowUnminimise(a.ctx)
	wruntime.WindowShow(a.ctx)
	wruntime.WindowSetAlwaysOnTop(a.ctx, true)
	wruntime.WindowSetAlwaysOnTop(a.ctx, false)
	// Relative paths belong to the second instance's folder, not ours.
	args := append([]string(nil), data.Args...)
	if data.WorkingDirectory != "" {
		rel := func(v string) string {
			v = strings.Trim(strings.TrimSpace(v), `"`)
			if v == "" || filepath.IsAbs(v) || filepath.VolumeName(v) != "" || os.IsPathSeparator(v[0]) {
				return v
			}
			return filepath.Join(data.WorkingDirectory, v)
		}
		for i := 0; i < len(args); i++ {
			switch a := args[i]; {
			case a == "--cwd" && i+1 < len(args):
				args[i+1] = rel(args[i+1])
				i++
			case strings.HasPrefix(a, "--cwd="):
				args[i] = "--cwd=" + rel(strings.TrimPrefix(a, "--cwd="))
			case !strings.HasPrefix(a, "-"):
				args[i] = rel(a)
			}
		}
	}
	if cwd := cwdFromArgs(args); cwd != "" {
		a.emit("launch:open", cwd)
	}
}
