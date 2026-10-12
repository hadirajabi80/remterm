//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// Explorer right-click entries, per user (no admin rights needed). On
// Windows 11 classic entries appear under "Show more options".
var contextMenuKeys = []struct{ key, arg string }{
	{`Software\Classes\Directory\shell\Termora`, `%V`},            // right-click a folder
	{`Software\Classes\Directory\Background\shell\Termora`, `%V`}, // right-click inside a folder
	{`Software\Classes\Drive\shell\Termora`, `%V`},                // right-click a drive
	{`Software\Classes\*\shell\Termora`, `%1`},                    // right-click a file → its folder
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
		_ = k.SetStringValue("", "Open in Termora")
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
	// Points at this copy of Termora (a moved/reinstalled exe needs re-registering).
	return exe != "" && len(v) > len(exe) && v[1:len(exe)+1] == exe
}

// ExplorerMenuEnabled reports whether "Open in Termora" is in Explorer's menu.
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
