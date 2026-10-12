# Remterm

**SSH, Remote Desktop and local terminals in one window** — for Windows 10/11. Remterm merges
[Termora](https://github.com/hadirajabi80/termora) (SSH workspace) and [Remora](https://github.com/hadirajabi80/remora)
(tabbed RDP manager with WALLIX auto-fill): RDP sessions open as tabs next to your SSH and local terminals.

## Install

Run **RemtermSetup-<version>.exe** (no admin rights needed; Windows SmartScreen: *More info → Run anyway*, it is not code-signed yet).
It installs to `%LOCALAPPDATA%\Programs\Remterm`, adds Start Menu and Desktop shortcuts, Explorer's **Open in Remterm** entry and an
*Apps & features* entry. Run it again to update. `/S` installs silently (`/S /classic` also switches on the full right-click menu).

- **Your data comes along.** SSH hosts, keys, snippets and settings from Termora are copied on first start; RDP machines and logins are
  read from Remora's encrypted vault (`%APPDATA%\RemoteHub\vault.dat`). Setup offers to remove the old Termora / Remora.
- **Right-click → Open in Remterm** opens a local terminal in that folder (in the running window, as a new tab). Windows 11 shows such
  entries under *Show more options*; setup (or Settings → Explorer integration) can switch on the full right-click menu so it shows
  directly.

### macOS

Download **Remterm-<version>-macOS.dmg** (universal: Apple Silicon and Intel, macOS 11+) and drag Remterm to Applications. It is not
notarized yet: the first time, right-click Remterm → **Open** → Open (or run `xattr -dr com.apple.quarantine /Applications/Remterm.app`).

- SSH, SFTP, port forwarding, keychain, snippets and local terminals (zsh / bash / fish) work as on Windows.
- **Remote Desktop**: the same machine list, WALLIX login, logins and import (passwords in the macOS Keychain). A session opens in
  Microsoft's **Windows App** (free, App Store) with the server and WALLIX login filled in and the password on the clipboard (⌘V).
  Sessions inside Remterm tabs, auto-fill and the master-password vault need Windows.
- **Finder**: turn on *Open in Remterm* in Settings → right-click a folder → Quick Actions → Open in Remterm; or drop a folder on the
  Dock icon.

The `.dmg` is built by GitHub Actions on every release (`build-macos.sh`, `.github/workflows/build.yml`).

## Features

**Remote Desktop** (sidebar → monitor icon)
- RDP sessions in tabs and split panes, next to SSH and terminals; **pop out** a session into its own window (another monitor) or go
  **fullscreen** with an mstsc-style bar — the session stays connected
- **WALLIX Bastion** aware: selector-bypass login (`{target}:{auth}:{user}`), and screen detection (Windows OCR) that fills the bastion
  login and the *Target Information Required* screen
- **Saved logins**: `Ctrl+Alt+K` in a session → pick a login → typed on the current screen; assign a login to a machine to auto-fill
- **Import** a pasted WALLIX target list (auto-grouped), favorites, recent, groups, quick connect to any IP (`Ctrl+Alt+P` or the palette)
- **Security**: AES-256-GCM vault, key protected by Windows DPAPI; optional master password (PBKDF2-SHA256), auto-lock and lock screen
  (`Ctrl+Alt+L`); the server key is pinned on first connect

**SSH & terminals** — everything Termora had: hosts in nested groups with inherited settings, SSH/Telnet/Serial, jump-host chains,
proxies, agent forwarding, keychain (generate/import keys, certificates, install key on server), identities, SFTP with two panes and
drag & drop, port forwarding (local/remote/SOCKS), split panes, broadcast input, workspaces, snippets, command history, session logs,
local shells via ConPTY (PowerShell, cmd, WSL, Git Bash), themes and backgrounds.

### Shortcuts

| Keys | Action |
|---|---|
| `Ctrl+Shift+P` | Command palette (hosts, machines, actions; type `user@host` or an IP to connect) |
| `Ctrl+Shift+T` / `Ctrl+Shift+`` ` | New connection / local terminal |
| `Ctrl+Tab`, `Ctrl+1…9` | Switch tabs (inside an RDP session: `Ctrl+Alt+PgDn/PgUp`, `Ctrl+Alt+1…9`) |
| `Ctrl+Alt+K` | Fill a saved login in the RDP session |
| `Ctrl+Alt+Enter` | RDP fullscreen on / off |
| `Ctrl+Alt+R` / `Ctrl+Alt+W` | Reconnect / close the RDP session |
| `Ctrl+Alt+L` | Lock (needs a master password) |

## How it is built

```
Remterm.exe      Go (Wails v2) + React/xterm.js UI — SSH, SFTP, tunnels, local terminals, Explorer integration
RemtermRdp.exe   C# / WinForms engine — Windows RDP ActiveX (mstscax), encrypted RDP vault, WALLIX auto-fill, OCR
```

Remterm starts the engine on demand and talks to it over a named pipe limited to your Windows account (JSON lines, one-time token).
Each RDP session is a native child window of Remterm's main window; the UI reports where the tab's content area is and the engine keeps
the session exactly there (hidden while a dialog or menu covers it — a still picture is shown instead).

## Build

Needs Go 1.26, Node 20+, .NET 10 SDK.

```powershell
.\build.ps1 -Run         # frontend + RDP engine + Remterm.exe into build\bin, then launch
.\build.ps1 -Installer   # also build\bin\RemtermSetup-<version>.exe (both exes, gzipped inside)
.\build.ps1 -SkipEngine  # reuse the built engine (faster UI/Go iterations)
```

UI-only development in a browser with a fake backend (no SSH/RDP): `npm --prefix frontend run dev`.

Tests: `go test -tags desktop,production ./...` (SSH integration tests against an in-process server, ConPTY round-trips).

Engine maintenance (no window): `RemtermRdp.exe --import <file>` · `--set-host <ip>` · `--dump`.
