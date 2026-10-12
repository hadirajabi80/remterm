//go:build windows

// Command TermoraSetup installs Termora for the current user (no admin
// rights): program files under %LOCALAPPDATA%\Programs\Termora, Start Menu
// and Desktop shortcuts, Explorer's "Open in Termora" entry and an
// Apps & features entry whose Uninstall runs `Termora.exe --uninstall`.
//
// Build with build.ps1 -Installer (it copies Termora.exe into payload/).
// `TermoraSetup.exe /S` installs silently.
package main

import (
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

//go:embed payload
var payload embed.FS

// Set at build time: -ldflags "-X main.version=1.2.3".
var version = "dev"

const (
	title        = "Termora Setup"
	uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\Termora` // must match cli_windows.go
	repoURL      = "https://github.com/hadirajabi80/termora"
	webView2URL  = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
	idYes        = 6
)

func main() {
	silent := false
	for _, a := range os.Args[1:] {
		if strings.EqualFold(a, "/S") || a == "--silent" {
			silent = true
		}
	}
	dir := filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Termora")

	if !silent && ask(fmt.Sprintf("Install Termora %s for %s?\n\n"+
		"• Installs to %s (no admin rights needed)\n"+
		"• Adds Start Menu and Desktop shortcuts\n"+
		"• Adds \"Open in Termora\" to Explorer's right-click menu\n\n"+
		"You can remove it any time from Settings → Apps.", version, os.Getenv("USERNAME"), dir)) != idYes {
		return
	}

	wasRunning, err := install(dir)
	if err != nil {
		if !silent {
			msg("Installation failed:\n\n"+err.Error(), windows.MB_ICONERROR)
		}
		os.Exit(1)
	}
	if silent {
		return
	}

	if !webView2Installed() &&
		ask("Termora needs the Microsoft Edge WebView2 Runtime, which is not installed on this PC.\n\nOpen the download page now?") == idYes {
		openURL(webView2URL)
	}

	done := "Termora is installed."
	if wasRunning {
		done += "\n\nAn older Termora window is still open — close and reopen it to use the new version."
	}
	if ask(done+"\n\nOpen Termora now?") == idYes {
		cmd := exec.Command(filepath.Join(dir, "Termora.exe"))
		cmd.Dir = dir
		_ = cmd.Start()
	}
}

// install copies the program and registers it. It reports whether an older
// copy was running (its file is renamed aside, which Windows allows).
func install(dir string) (wasRunning bool, err error) {
	exeData, err := fs.ReadFile(payload, "payload/Termora.exe")
	if err != nil {
		return false, errors.New("this setup was built without Termora.exe inside")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, err
	}
	exe := filepath.Join(dir, "Termora.exe")
	old := filepath.Join(dir, "Termora.old.exe")
	_ = os.Remove(old) // left over from a previous update
	if _, err := os.Stat(exe); err == nil {
		if err := os.Remove(exe); err != nil {
			// In use: move it aside so the new version can take its place.
			if err := os.Rename(exe, old); err != nil {
				return false, fmt.Errorf("could not replace %s: %w", exe, err)
			}
			wasRunning = true
		}
	}
	tmp := exe + ".tmp"
	if err := os.WriteFile(tmp, exeData, 0o755); err != nil {
		return wasRunning, err
	}
	if err := os.Rename(tmp, exe); err != nil {
		return wasRunning, err
	}

	for _, id := range []*windows.KNOWNFOLDERID{windows.FOLDERID_Programs, windows.FOLDERID_Desktop} {
		if folder, err := windows.KnownFolderPath(id, 0); err == nil {
			if err := createShortcut(filepath.Join(folder, "Termora.lnk"), exe, dir); err != nil {
				return wasRunning, fmt.Errorf("create shortcut: %w", err)
			}
		}
	}

	if err := registerUninstall(exe, dir, len(exeData)); err != nil {
		return wasRunning, fmt.Errorf("register in Apps & features: %w", err)
	}

	// The app owns the Explorer menu entries (it can also toggle them in its settings).
	if err := hiddenCommand(exe, "--install-context-menu").Run(); err != nil {
		return wasRunning, fmt.Errorf("add Explorer menu: %w", err)
	}
	return wasRunning, nil
}

func registerUninstall(exe, dir string, size int) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, uninstallKey, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer k.Close()
	for name, val := range map[string]string{
		"DisplayName":     "Termora",
		"DisplayVersion":  version,
		"Publisher":       "Termora",
		"DisplayIcon":     exe + ",0",
		"InstallLocation": dir,
		"UninstallString": `"` + exe + `" --uninstall`,
		"URLInfoAbout":    repoURL,
		"InstallDate":     time.Now().Format("20060102"),
	} {
		if err := k.SetStringValue(name, val); err != nil {
			return err
		}
	}
	_ = k.SetDWordValue("NoModify", 1)
	_ = k.SetDWordValue("NoRepair", 1)
	return k.SetDWordValue("EstimatedSize", uint32(size/1024))
}

// createShortcut uses the Windows Script Host COM object through PowerShell.
func createShortcut(lnk, target, workDir string) error {
	q := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	script := fmt.Sprintf(
		"$s=(New-Object -ComObject WScript.Shell).CreateShortcut(%s);$s.TargetPath=%s;$s.WorkingDirectory=%s;"+
			"$s.IconLocation=%s;$s.Description='Termora SSH workspace';$s.Save()",
		q(lnk), q(target), q(workDir), q(target+",0"))
	out, err := hiddenCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func webView2Installed() bool {
	const client = `Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`
	for _, loc := range []struct {
		root registry.Key
		path string
	}{
		{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\` + client},
		{registry.LOCAL_MACHINE, `SOFTWARE\` + client},
		{registry.CURRENT_USER, `Software\` + client},
	} {
		k, err := registry.OpenKey(loc.root, loc.path, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		v, _, err := k.GetStringValue("pv")
		k.Close()
		if err == nil && v != "" && v != "0.0.0.0" {
			return true
		}
	}
	return false
}

func hiddenCommand(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	return cmd
}

func openURL(u string) {
	_ = hiddenCommand("rundll32.exe", "url.dll,FileProtocolHandler", u).Start()
}

func ask(text string) int {
	return box(text, windows.MB_YESNO|windows.MB_ICONQUESTION)
}

func msg(text string, flags uint32) {
	box(text, flags)
}

func box(text string, flags uint32) int {
	t, _ := windows.UTF16PtrFromString(title)
	m, _ := windows.UTF16PtrFromString(text)
	r, _ := windows.MessageBox(0, m, t, flags|windows.MB_SETFOREGROUND)
	return int(r)
}
