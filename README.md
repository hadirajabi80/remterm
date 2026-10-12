# Termora

Desktop SSH workspace — Go ([Wails v2](https://wails.io)) + React + xterm.js. Single ~12 MB exe, uses the system WebView2.

## Build & run

```powershell
.\build.ps1 -Run        # npm install (first time) + frontend build + go build, then launch
.\build.ps1 -Shortcut   # also create Desktop + Start Menu shortcuts to build\bin\Termora.exe
.\build.ps1 -Installer  # also build build\bin\TermoraSetup-<version>.exe to give to others
```

Output: `build\bin\Termora.exe`. No Wails CLI needed — the script passes the `desktop,production` build tags itself.

The app icon is drawn in code by `tools/appicon`, which also writes the DPI-aware manifest and version info into `rsrc_windows_*.syso` (linked automatically by `go build`). After changing the icon, regenerate with `go run ./tools/appicon`; `build/appicon.png` and `build/windows/icon.ico` are written for reuse elsewhere.

## Installer

`TermoraSetup-<version>.exe` installs for the current user without admin rights: `%LOCALAPPDATA%\Programs\Termora`, Start Menu + Desktop shortcuts, Explorer's **Open in Termora** entry and an *Apps & features* entry (uninstall removes everything; it asks before deleting saved hosts). Run it again to update. `/S` installs silently. The exe is not code-signed yet, so Windows SmartScreen shows *More info → Run anyway* the first time.

UI-only development in a browser (fake in-memory backend, no SSH):

```powershell
npm --prefix frontend run dev
```

## Features

**Hosts & connections**
- Hosts in **nested groups** (`Clients/Acme/Prod`) with **group settings** inherited by every host below (identity, jump host, proxy, agent forwarding, environment variables, startup command, color scheme); **tags** with tag filters; environment badges (prod gets a red frame)
- Protocols: **SSH**, **Telnet** (window size, terminal type, auto-login), **Serial** (port, baud, data/stop bits, parity), plus local shells
- **Host chaining**: jump hosts may have their own jump hosts (loops detected); **SOCKS5 / HTTP proxy** for the first hop; **agent forwarding** (Windows OpenSSH agent or Termora's keys); **environment variables** (SendEnv/AcceptEnv)
- Import from `~/.ssh/config` (incl. `ProxyJump`) and **PuTTY** sessions; quick connect remembers servers; "connect to all hosts" of a group in one tab
- Host key verification against `~/.ssh/known_hosts` with a **Known hosts** manager

**Keychain**
- **Generate** Ed25519 / ECDSA / RSA keys, **import** keys (file or paste, passphrase-protected), **OpenSSH certificates**, copy public key
- **Install a key on a server** (appends to `authorized_keys` once and links it to the host)
- **Identities**: username + password/key reused by many hosts or whole groups; secrets in Windows Credential Manager

**Files & tunnels**
- **SFTP**: two panes (this PC or any host on either side), drag & drop between panes and **from Explorer**, multi-select, rename, delete, new folder, **permissions**, hidden files, sortable columns, server-to-server copy, **transfers** with progress/cancel, **edit remote files** in your editor (every save uploads back)
- **Port forwarding**: Local, Remote and Dynamic (SOCKS5) rules, start/stop, live status, **auto-start** with reconnect

**Terminal**
- Tabs and **split panes** (`Alt+Shift+=`/`-`/`D`, drag dividers, `Alt+Arrows`, zoom `Ctrl+Shift+Z`), **broadcast input** (`Ctrl+Shift+A`), unread-output dots
- **Workspaces**: save a tab's layout and connections (`Ctrl+S`) and reopen it in one click
- **Snippets** (~75 built in, `{{placeholders}}`), **run a snippet on several hosts** at once
- **Command history** autocomplete (gray suggestion, `↑` list) — passwords at hidden prompts are never stored
- **Session logs**: recorded per session (last 5 per server), bookmarks with notes, replay with colors, search, export to .txt
- Local terminals via ConPTY (PowerShell, cmd, WSL, Git Bash), Explorer **Open in Termora**
- Appearance: backgrounds, 9 color schemes (per host or group too), font size; find in scrollback, clickable links, Windows-style copy/paste

## Tests

`go test -tags desktop,production ./...` runs unit tests plus integration tests against an in-process SSH server (password/key auth, identities, 3-hop jump chain, group inheritance, SFTP transfers, local + SOCKS forwarding, SOCKS proxy, Telnet negotiation, session-log retention) and ConPTY round-trips with the installed shells.

## Not (yet) like Termius

Cloud sync and team vaults (need a server), AWS/DigitalOcean/Azure import, FIDO2/biometric keys, Mosh, AI command generation.