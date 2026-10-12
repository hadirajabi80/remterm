//go:build !windows

package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"github.com/creack/pty"
)

// LocalShell is a terminal program that can run on this machine.
type LocalShell struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Command string `json:"command"`
}

// ListShells returns the login shell first, then the other installed shells.
func (a *App) ListShells() []LocalShell {
	var out []LocalShell
	seen := map[string]bool{}
	add := func(path string) {
		if path == "" || !fileExists(path) {
			return
		}
		id := filepath.Base(path)
		if seen[id] {
			return
		}
		seen[id] = true
		out = append(out, LocalShell{ID: id, Name: id, Command: path})
	}
	add(os.Getenv("SHELL"))
	for _, p := range []string{"/bin/zsh", "/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/opt/homebrew/bin/bash", "/bin/bash"} {
		add(p)
	}
	if f, err := os.Open("/etc/shells"); err == nil {
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if line := strings.TrimSpace(sc.Text()); strings.HasPrefix(line, "/") {
				add(line)
			}
		}
	}
	if len(out) == 0 {
		add("/bin/sh")
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
	if req.Cwd != "" {
		if st, err := os.Stat(req.Cwd); err == nil && st.IsDir() {
			dir = req.Cwd
		}
	}

	cmd := exec.Command(shell.Command, "-l") // login shell: reads the user's profile like Terminal.app
	cmd.Dir = dir
	env := append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor", "TERM_PROGRAM=Remterm")
	if os.Getenv("LANG") == "" {
		env = append(env, "LANG=en_US.UTF-8") // apps started from Finder get no locale
	}
	cmd.Env = env
	cols, rows := clamp(req.Cols, 20, 1000, 80), clamp(req.Rows, 5, 500, 24)
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return fmt.Errorf("start %s: %w", shell.Name, err)
	}

	s := &Session{
		id:    req.SessionID,
		stdin: f,
		resize: func(c, r int) error {
			return pty.Setsize(f, &pty.Winsize{Cols: uint16(c), Rows: uint16(r)})
		},
		closeFn: func() {
			if cmd.Process != nil {
				_ = cmd.Process.Signal(syscall.SIGHUP)
			}
			_ = f.Close()
		},
		done: make(chan struct{}),
	}
	title := shell.Name
	if req.Cwd != "" {
		title += " — " + req.Cwd
	}
	a.registerSession(s, "local:"+shell.ID, title)

	go a.pump(s, f)
	go func() {
		err := cmd.Wait()
		code := -1
		if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		}
		if err != nil && code < 0 {
			a.closeSession(s, "Process ended", false, -1)
			return
		}
		a.closeSession(s, fmt.Sprintf("Process exited (code %d)", code), false, code)
	}()
	return nil
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func handleCommandLine([]string) bool { return false }

// ---- Finder: "Open in Remterm" Quick Action (right-click a folder → Quick Actions) ----

func servicePath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Services", "Open in Remterm.workflow")
}

func (a *App) ExplorerMenuEnabled() bool {
	if runtime.GOOS != "darwin" {
		return false
	}
	_, err := os.Stat(servicePath())
	return err == nil
}

func (a *App) SetExplorerMenu(enable bool) error {
	if runtime.GOOS != "darwin" {
		return errors.New("not available on this system")
	}
	dir := servicePath()
	if !enable {
		return os.RemoveAll(dir)
	}
	if err := os.MkdirAll(filepath.Join(dir, "Contents"), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "Contents", "Info.plist"), []byte(serviceInfoPlist), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "Contents", "document.wflow"), []byte(serviceWorkflow), 0o644); err != nil {
		return err
	}
	_ = exec.Command("/System/Library/CoreServices/pbs", "-update").Run() // refresh the Services menu
	return nil
}

func openWithDefaultApp(path string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", path).Start()
	}
	return exec.Command("xdg-open", path).Start()
}

func (a *App) ImportPuTTY() (int, error) { return 0, errors.New("PuTTY import is Windows-only") }

const serviceInfoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>Open in Remterm</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.folder</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
`

// An Automator "Run Shell Script" action: open -a Remterm "<folder>".
const serviceWorkflow = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>523</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>for f in "$@"; do open -a Remterm "$f"; done</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/zsh</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>0B6A4C59-9D5B-4C8E-9C59-1D4A3E8C2F01</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
				</array>
				<key>OutputUUID</key>
				<string>6E2D7A17-41B4-4D1C-8A38-2F7B9C0D5E02</string>
				<key>UUID</key>
				<string>A3C1E9B4-5F62-4B1A-9E07-7C2D8F3A6B03</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>arguments</key>
				<dict/>
				<key>isViewVisible</key>
				<integer>1</integer>
				<key>location</key>
				<string>309.000000:253.000000</string>
				<key>nibPath</key>
				<string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
			<key>isViewVisible</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>applicationBundleIDsByPath</key>
		<dict/>
		<key>applicationPaths</key>
		<array/>
		<key>inputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject.folder</string>
		<key>outputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>presentationMode</key>
		<integer>15</integer>
		<key>processesInput</key>
		<false/>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject.folder</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<false/>
		<key>systemImageName</key>
		<string>NSActionTemplate</string>
		<key>useAutomaticInputType</key>
		<false/>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
`
