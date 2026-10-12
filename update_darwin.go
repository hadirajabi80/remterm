//go:build darwin

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// installUpdate replaces this Remterm.app with the one in the downloaded
// .dmg and starts it again. Downloaded this way the app has no quarantine
// flag, so macOS does not ask to confirm it again.
func (a *App) installUpdate(dmg string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	bundle := filepath.Dir(filepath.Dir(filepath.Dir(exe))) // …/Remterm.app/Contents/MacOS/Remterm
	if !strings.HasSuffix(bundle, ".app") {
		return errors.New("Remterm is not running from an app bundle; install the update by hand")
	}

	mount, err := os.MkdirTemp("", "remterm-dmg-")
	if err != nil {
		return err
	}
	if out, err := exec.Command("hdiutil", "attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, dmg).CombinedOutput(); err != nil {
		return fmt.Errorf("open the update: %s", strings.TrimSpace(string(out)))
	}
	defer exec.Command("hdiutil", "detach", "-quiet", mount).Run()

	staged := bundle + ".new"
	old := bundle + ".old"
	_ = os.RemoveAll(staged)
	_ = os.RemoveAll(old)
	if out, err := exec.Command("ditto", filepath.Join(mount, "Remterm.app"), staged).CombinedOutput(); err != nil {
		return fmt.Errorf("copy the update: %s", strings.TrimSpace(string(out)))
	}
	_ = exec.Command("xattr", "-dr", "com.apple.quarantine", staged).Run()
	if err := os.Rename(bundle, old); err != nil {
		_ = os.RemoveAll(staged)
		return fmt.Errorf("replace Remterm (is it in a folder you can write to?): %w", err)
	}
	if err := os.Rename(staged, bundle); err != nil {
		_ = os.Rename(old, bundle)
		return err
	}
	_ = os.RemoveAll(old)

	// Start the new version once this one has quit.
	_ = exec.Command("/bin/sh", "-c", fmt.Sprintf("sleep 1; open -n %q", bundle)).Start()
	wruntime.Quit(a.ctx)
	return nil
}
