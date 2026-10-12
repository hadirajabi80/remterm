//go:build windows

// Command RemtermSetup installs Remterm for the current user (no admin
// rights): program files under %LOCALAPPDATA%\Programs\Remterm (Remterm.exe
// and the Remote Desktop engine RemtermRdp.exe), Start Menu and Desktop
// shortcuts, Explorer's "Open in Remterm" entry and an Apps & features entry
// whose Uninstall runs `Remterm.exe --uninstall`. It can also switch Windows
// 11 back to the full right-click menu (opt-in) and remove the older
// Termora / Remora apps that Remterm replaces (their data is kept).
//
// Build with build.ps1 -Installer (it puts the gzipped exes into payload/).
// `RemtermSetup.exe /S` installs silently; add /classic for the full menu.
package main

import (
	"compress/gzip"
	"embed"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

//go:embed payload
var payload embed.FS

// Set at build time: -ldflags "-X main.version=1.2.3".
var version = "dev"

const (
	title          = "Remterm Setup"
	uninstallKey   = `Software\Microsoft\Windows\CurrentVersion\Uninstall\Remterm`   // must match cli_windows.go
	classicMenuKey = `Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}` // must match shellmenu_windows.go
	repoURL        = "https://github.com/hadirajabi80/remterm"
	webView2URL    = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
)

var programs = []string{"Remterm.exe", "RemtermRdp.exe"}

func main() {
	silent, classic := false, false
	for _, a := range os.Args[1:] {
		switch strings.ToLower(a) {
		case "/s", "--silent":
			silent = true
		case "/classic", "--classic-menu":
			classic = true
		}
	}
	dir := filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Remterm")
	win11 := isWindows11()

	if !silent {
		content := "• SSH, SFTP, port forwarding and local terminals\n" +
			"• Remote Desktop in tabs, with WALLIX bastion auto-fill\n" +
			"• \"Open in Remterm\" in Explorer's right-click menu\n" +
			"• Start Menu and Desktop shortcuts"
		verify := ""
		if win11 {
			verify = "Show \"Open in Remterm\" in the main right-click menu"
		}
		res, err := taskDialog(dialog{
			instruction: "Install Remterm " + version,
			content:     content,
			buttons:     []button{{101, "Install\nFor " + os.Getenv("USERNAME") + " — no admin rights needed"}},
			cancel:      true,
			verify:      verify,
			expanded:    "Installs to " + dir + ".\nYour saved hosts, keys, Remote Desktop machines and logins from Termora or Remora are kept and used automatically.\nWindows 11 normally shows extra right-click entries under \"Show more options\"; the option above brings back the full menu for your account only (Explorer restarts once). You can change it later in Remterm's settings.",
			expandLabel: "Details",
		})
		if err != nil { // no task dialog: plain question
			if ask(fmt.Sprintf("Install Remterm %s for %s?\n\n%s\n\nInstalls to %s (no admin rights needed).", version, os.Getenv("USERNAME"), content, dir)) != idYes {
				return
			}
		} else if res.button != 101 {
			return
		} else {
			classic = win11 && res.verified
		}
	}

	// Remora shares the encrypted RDP vault with Remterm (and Termora its
	// hosts): both writing at once could lose changes, so ask to close them.
	for !silent {
		running := runningProcesses("Remora.exe", "Termora.exe")
		if len(running) == 0 {
			break
		}
		text := strings.Join(running, " and ") + " is still open. It uses the same saved machines, logins and hosts as Remterm — close it first so nothing is overwritten."
		res, err := taskDialog(dialog{
			instruction: "Please close " + strings.Join(running, " and "),
			content:     text,
			buttons:     []button{{401, "I closed it — continue"}, {402, "Continue anyway"}},
			cancel:      true,
		})
		if err != nil {
			if ask(text+"\n\nContinue anyway?") != idYes {
				return
			}
			break
		}
		if res.button == 402 {
			break
		}
		if res.button != 401 {
			return
		}
	}

	wasRunning, err := install(dir)
	if err != nil {
		if !silent {
			msg("Installation failed:\n\n"+err.Error(), windows.MB_ICONERROR)
		}
		os.Exit(1)
	}

	if classic && win11 && !classicMenuOn() {
		if setClassicMenu() == nil {
			restartExplorer()
		}
	}
	if silent {
		return
	}

	removeOldApps(dir)

	if !webView2Installed() &&
		ask("Remterm needs the Microsoft Edge WebView2 Runtime, which is not installed on this PC.\n\nOpen the download page now?") == idYes {
		openURL(webView2URL)
	}

	done := "Remterm is installed."
	if wasRunning {
		done += " An older Remterm window is still open — close it and open Remterm again to use the new version."
	}
	if classic && win11 {
		done += "\n\nRight-click a folder (or empty space in one) and choose \"Open in Remterm\"."
	} else if win11 {
		done += "\n\nTo open a terminal from Explorer: right-click a folder → Show more options → Open in Remterm."
	}
	res, err := taskDialog(dialog{
		instruction: "Remterm is ready",
		content:     done,
		buttons:     []button{{201, "Open Remterm"}},
		closeButton: true,
	})
	if (err == nil && res.button == 201) || (err != nil && ask(done+"\n\nOpen Remterm now?") == idYes) {
		cmd := exec.Command(filepath.Join(dir, "Remterm.exe"))
		cmd.Dir = dir
		_ = cmd.Start()
	}
}

// install copies the programs and registers them. It reports whether an
// older copy was running (its file is renamed aside, which Windows allows).
func install(dir string) (wasRunning bool, err error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, err
	}
	total := 0
	for _, name := range programs {
		n, running, err := extract(name, dir)
		if err != nil {
			return wasRunning, err
		}
		total += n
		wasRunning = wasRunning || running
	}
	exe := filepath.Join(dir, "Remterm.exe")

	for _, id := range []*windows.KNOWNFOLDERID{windows.FOLDERID_Programs, windows.FOLDERID_Desktop} {
		if folder, err := windows.KnownFolderPath(id, 0); err == nil {
			if err := createShortcut(filepath.Join(folder, "Remterm.lnk"), exe, dir); err != nil {
				return wasRunning, fmt.Errorf("create shortcut: %w", err)
			}
		}
	}

	if err := registerUninstall(exe, dir, total); err != nil {
		return wasRunning, fmt.Errorf("register in Apps & features: %w", err)
	}

	// The app owns the Explorer menu entries (it can also toggle them in its settings).
	if err := hiddenCommand(exe, "--install-context-menu").Run(); err != nil {
		return wasRunning, fmt.Errorf("add Explorer menu: %w", err)
	}
	return wasRunning, nil
}

// extract unpacks payload/<name>.gz into dir.
func extract(name, dir string) (size int, wasRunning bool, err error) {
	f, err := payload.Open("payload/" + name + ".gz")
	if err != nil {
		return 0, false, fmt.Errorf("this setup was built without %s inside", name)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return 0, false, err
	}
	defer zr.Close()

	target := filepath.Join(dir, name)
	old := strings.TrimSuffix(target, ".exe") + ".old.exe"
	_ = os.Remove(old) // left over from a previous update
	if _, err := os.Stat(target); err == nil {
		if err := os.Remove(target); err != nil {
			// In use: move it aside so the new version can take its place.
			if err := os.Rename(target, old); err != nil {
				return 0, false, fmt.Errorf("could not replace %s: %w", target, err)
			}
			wasRunning = true
		}
	}
	tmp := target + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return 0, wasRunning, err
	}
	n, err := io.Copy(out, zr)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return 0, wasRunning, fmt.Errorf("unpack %s: %w", name, err)
	}
	return int(n), wasRunning, os.Rename(tmp, target)
}

func registerUninstall(exe, dir string, size int) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, uninstallKey, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer k.Close()
	for name, val := range map[string]string{
		"DisplayName":     "Remterm",
		"DisplayVersion":  version,
		"Publisher":       "Remterm",
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

// ---- the apps Remterm replaces ----

type oldApp struct {
	name      string
	dir       string
	shortcuts []string
	regKeys   []string // HKCU, deleted with their subkeys
}

func oldApps() []oldApp {
	local := filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs")
	var desktop, startMenu string
	if d, err := windows.KnownFolderPath(windows.FOLDERID_Desktop, 0); err == nil {
		desktop = d
	}
	if d, err := windows.KnownFolderPath(windows.FOLDERID_Programs, 0); err == nil {
		startMenu = d
	}
	lnk := func(n string) []string {
		return []string{filepath.Join(desktop, n+".lnk"), filepath.Join(startMenu, n+".lnk")}
	}
	var termoraMenu []string
	for _, base := range []string{`Software\Classes\Directory\shell`, `Software\Classes\Directory\Background\shell`, `Software\Classes\Drive\shell`, `Software\Classes\*\shell`} {
		termoraMenu = append(termoraMenu, base+`\Termora`)
	}
	return []oldApp{
		{"Termora", filepath.Join(local, "Termora"), lnk("Termora"), append(termoraMenu, `Software\Microsoft\Windows\CurrentVersion\Uninstall\Termora`)},
		{"Remora", filepath.Join(local, "Remora"), lnk("Remora"), nil},
	}
}

func (o oldApp) present() bool {
	if _, err := os.Stat(o.dir); err == nil {
		return true
	}
	for _, s := range o.shortcuts {
		if _, err := os.Stat(s); err == nil {
			return true
		}
	}
	return false
}

func (o oldApp) remove() {
	for _, s := range o.shortcuts {
		_ = os.Remove(s)
	}
	for _, k := range o.regKeys {
		deleteKeyTree(registry.CURRENT_USER, k)
	}
	if err := os.RemoveAll(o.dir); err != nil {
		// Still running: remove the folder once it has closed.
		cmd := hiddenCommand("cmd.exe", "/c", `ping 127.0.0.1 -n 30 >nul & rmdir /s /q "`+o.dir+`"`)
		_ = cmd.Start()
	}
}

// removeOldApps offers to uninstall Termora / Remora. Their data stays:
// Remterm reads Termora's hosts and Remora's encrypted RDP vault.
func removeOldApps(dir string) {
	var found []oldApp
	for _, o := range oldApps() {
		if o.present() && !strings.EqualFold(filepath.Clean(o.dir), filepath.Clean(dir)) {
			found = append(found, o)
		}
	}
	if len(found) == 0 {
		return
	}
	names := found[0].name
	if len(found) == 2 {
		names = found[0].name + " and " + found[1].name
	}
	text := "Remterm replaces " + names + ". Your SSH hosts, keys, snippets, Remote Desktop machines and logins are kept — Remterm already uses them."
	res, err := taskDialog(dialog{
		instruction: "Remove the old " + names + "?",
		content:     text,
		buttons: []button{
			{301, "Remove " + names + "\nShortcuts, program files and menu entries (recommended)"},
			{302, "Keep them"},
		},
	})
	if (err == nil && res.button == 301) || (err != nil && ask("Remove the old "+names+"?\n\n"+text) == idYes) {
		for _, o := range found {
			o.remove()
		}
	}
}

// runningProcesses returns the app names (without .exe) of the given executables that are running.
func runningProcesses(exes ...string) []string {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snap)
	found := map[string]bool{}
	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	for err = windows.Process32First(snap, &pe); err == nil; err = windows.Process32Next(snap, &pe) {
		name := windows.UTF16ToString(pe.ExeFile[:])
		for _, e := range exes {
			if strings.EqualFold(name, e) {
				found[strings.TrimSuffix(e, ".exe")] = true
			}
		}
	}
	var out []string
	for _, e := range exes {
		if n := strings.TrimSuffix(e, ".exe"); found[n] {
			out = append(out, n)
		}
	}
	return out
}

func deleteKeyTree(root registry.Key, path string) {
	k, err := registry.OpenKey(root, path, registry.ENUMERATE_SUB_KEYS)
	if err == nil {
		subs, _ := k.ReadSubKeyNames(-1)
		k.Close()
		for _, s := range subs {
			deleteKeyTree(root, path+`\`+s)
		}
	}
	_ = registry.DeleteKey(root, path)
}

// ---- Windows 11 full right-click menu ----

func isWindows11() bool {
	maj, _, build := windows.RtlGetNtVersionNumbers()
	return maj >= 10 && build >= 22000
}

func classicMenuOn() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, classicMenuKey+`\InprocServer32`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	k.Close()
	return true
}

func setClassicMenu() error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, classicMenuKey+`\InprocServer32`, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue("", "")
}

// restartExplorer applies the menu change (Explorer reads it at start).
func restartExplorer() {
	_ = hiddenCommand("taskkill.exe", "/f", "/im", "explorer.exe").Run()
	time.Sleep(800 * time.Millisecond)
	_ = exec.Command(filepath.Join(os.Getenv("WINDIR"), "explorer.exe")).Start()
}

// ---- helpers ----

// createShortcut uses the Windows Script Host COM object through PowerShell.
func createShortcut(lnk, target, workDir string) error {
	q := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	script := fmt.Sprintf(
		"$s=(New-Object -ComObject WScript.Shell).CreateShortcut(%s);$s.TargetPath=%s;$s.WorkingDirectory=%s;"+
			"$s.IconLocation=%s;$s.Description='Remterm - SSH, Remote Desktop and terminals';$s.Save()",
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

const idYes = 6

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
