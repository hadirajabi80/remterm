//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// MessageBox results (not exported by x/sys/windows).
const idYes = 6

// Must match installer/main.go.
const uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\Remterm`

// handleCommandLine runs one-shot actions that need no window. It returns
// true when Remterm should exit afterwards.
func handleCommandLine(args []string) bool {
	for _, a := range args {
		switch a {
		case "--install-context-menu":
			if err := installContextMenu(); err != nil {
				messageBox("Remterm", "Could not add the Explorer menu: "+err.Error(), windows.MB_ICONERROR)
				os.Exit(1)
			}
			return true
		case "--uninstall-context-menu":
			_ = uninstallContextMenu()
			return true
		case "--uninstall":
			runUninstall()
			return true
		}
	}
	return false
}

func installDir() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Remterm")
}

func shortcutPaths() []string {
	var out []string
	for _, id := range []*windows.KNOWNFOLDERID{windows.FOLDERID_Desktop, windows.FOLDERID_Programs} {
		if dir, err := windows.KnownFolderPath(id, 0); err == nil {
			out = append(out, filepath.Join(dir, "Remterm.lnk"))
		}
	}
	return out
}

func runUninstall() {
	const title = "Uninstall Remterm"
	if messageBox(title, "Remove Remterm from this computer?", windows.MB_YESNO|windows.MB_ICONQUESTION) != idYes {
		return
	}
	_ = uninstallContextMenu()
	for _, p := range shortcutPaths() {
		_ = os.Remove(p)
	}
	if err := registry.DeleteKey(registry.CURRENT_USER, uninstallKey); err != nil && !errors.Is(err, registry.ErrNotExist) {
		messageBox(title, "Could not remove the Apps & features entry: "+err.Error(), windows.MB_ICONWARNING)
	}

	if messageBox(title,
		"Also delete your saved hosts, snippets, settings, command history and your Remote Desktop machines and logins?\n\n"+
			"Choose No to keep them for a later reinstall. SSH passwords live in Windows Credential Manager (entries named \"Remterm\").",
		windows.MB_YESNO|windows.MB_ICONQUESTION|windows.MB_DEFBUTTON2) == idYes {
		if dir, err := os.UserConfigDir(); err == nil {
			_ = os.RemoveAll(filepath.Join(dir, "Remterm"))
			_ = os.RemoveAll(filepath.Join(dir, "RemoteHub")) // the encrypted RDP vault (shared with Remora)
		}
	}

	// Remove the program folder once this process has exited — but only the
	// real install location, never a development build folder.
	exe, _ := os.Executable()
	dir := filepath.Dir(exe)
	if strings.EqualFold(filepath.Clean(dir), filepath.Clean(installDir())) {
		cmd := exec.Command("cmd.exe", "/c", `ping 127.0.0.1 -n 3 >nul & rmdir /s /q "`+dir+`"`)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
		_ = cmd.Start()
	}
	messageBox(title, "Remterm has been removed.", windows.MB_ICONINFORMATION)
}
