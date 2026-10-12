//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// Windows 11's new right-click menu only lists packaged (signed) apps; other
// entries sit under "Show more options". This per-user switch, which Remterm
// offers but never turns on by itself, brings back the full classic menu.
const classicMenuKey = `Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}`

// ClassicMenuState: supported is false before Windows 11 (the menu is classic already).
type ClassicMenuState struct {
	Supported bool `json:"supported"`
	Enabled   bool `json:"enabled"`
}

func (a *App) ClassicMenu() ClassicMenuState {
	maj, _, build := windows.RtlGetNtVersionNumbers()
	if maj < 10 || build < 22000 {
		return ClassicMenuState{}
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, classicMenuKey+`\InprocServer32`, registry.QUERY_VALUE)
	if err == nil {
		k.Close()
	}
	return ClassicMenuState{Supported: true, Enabled: err == nil}
}

// SetClassicMenu switches Explorer's full right-click menu on or off for this
// user. Explorer reads it at start, so it applies after RestartExplorer.
func (a *App) SetClassicMenu(enable bool) error {
	if !enable {
		for _, k := range []string{classicMenuKey + `\InprocServer32`, classicMenuKey} {
			if err := registry.DeleteKey(registry.CURRENT_USER, k); err != nil && !errors.Is(err, registry.ErrNotExist) {
				return err
			}
		}
		return nil
	}
	k, _, err := registry.CreateKey(registry.CURRENT_USER, classicMenuKey+`\InprocServer32`, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue("", "")
}

// RestartExplorer restarts the Windows shell so a menu change shows up.
func (a *App) RestartExplorer() error {
	kill := exec.Command("taskkill.exe", "/f", "/im", "explorer.exe")
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	_ = kill.Run()
	time.Sleep(800 * time.Millisecond)
	return exec.Command(filepath.Join(os.Getenv("WINDIR"), "explorer.exe")).Start()
}

// Explorer right-click entries, per user (no admin rights needed). On
// Windows 11 classic entries appear under "Show more options".
var contextMenuKeys = []struct{ key, arg string }{
	{`Software\Classes\Directory\shell\Remterm`, `%V`},            // right-click a folder
	{`Software\Classes\Directory\Background\shell\Remterm`, `%V`}, // right-click inside a folder
	{`Software\Classes\Drive\shell\Remterm`, `%V`},                // right-click a drive
	{`Software\Classes\*\shell\Remterm`, `%1`},                    // right-click a file → its folder
}

func installContextMenu() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, _ = filepath.Abs(exe)
	for _, e := range contextMenuKeys {
		k, _, err := registry.CreateKey(registry.CURRENT_USER, e.key, registry.ALL_ACCESS)
		if err != nil {
			return err
		}
		_ = k.SetStringValue("", "Open in Remterm")
		_ = k.SetStringValue("Icon", exe+",0")
		k.Close()
		c, _, err := registry.CreateKey(registry.CURRENT_USER, e.key+`\command`, registry.ALL_ACCESS)
		if err != nil {
			return err
		}
		err = c.SetStringValue("", fmt.Sprintf(`"%s" --cwd "%s"`, exe, e.arg))
		c.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func uninstallContextMenu() error {
	var firstErr error
	for _, e := range contextMenuKeys {
		for _, k := range []string{e.key + `\command`, e.key} {
			if err := registry.DeleteKey(registry.CURRENT_USER, k); err != nil && !errors.Is(err, registry.ErrNotExist) && firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

func contextMenuInstalled() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, contextMenuKeys[0].key+`\command`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, err := k.GetStringValue("")
	if err != nil {
		return false
	}
	exe, _ := os.Executable()
	// Points at this copy of Remterm (a moved/reinstalled exe needs re-registering).
	return exe != "" && len(v) > len(exe) && v[1:len(exe)+1] == exe
}

// ExplorerMenuEnabled reports whether "Open in Remterm" is in Explorer's menu.
func (a *App) ExplorerMenuEnabled() bool { return contextMenuInstalled() }

func (a *App) SetExplorerMenu(enable bool) error {
	if enable {
		return installContextMenu()
	}
	return uninstallContextMenu()
}

// messageBox shows a native dialog; used for command-line actions that run
// before (or without) the UI.
func messageBox(title, text string, flags uint32) int {
	t, _ := windows.UTF16PtrFromString(title)
	m, _ := windows.UTF16PtrFromString(text)
	ret, _ := windows.MessageBox(0, m, t, flags|windows.MB_SETFOREGROUND)
	return int(ret)
}

// openWithDefaultApp opens a file or folder like a double-click in Explorer.
func openWithDefaultApp(path string) error {
	verb, _ := windows.UTF16PtrFromString("open")
	file, _ := windows.UTF16PtrFromString(path)
	dir, _ := windows.UTF16PtrFromString(filepath.Dir(path))
	return windows.ShellExecute(0, verb, file, nil, dir, windows.SW_SHOWNORMAL)
}
