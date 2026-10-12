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
	if cwd := cwdFromArgs(data.Args); cwd != "" {
		a.emit("launch:open", cwd)
	}
}
