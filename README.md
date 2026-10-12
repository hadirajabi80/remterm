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

## Features (phase 1)

- Saved hosts with groups and environment tags (prod tabs get a red frame/badge), `~/.ssh/config` import (incl. `ProxyJump`)
- Every server you log into is remembered: quick connects (`user@host:port`) are saved to the *Quick connect* group after a successful login, connecting to an already-saved server reuses its settings, and hosts are ordered by last use (welcome screen "Recent", command palette)
- Auth: private keys (default `~/.ssh/id_*` or a chosen file), Windows OpenSSH agent, password / keyboard-interactive; prompts for password or key passphrase when needed and can remember it in **Windows Credential Manager**
- Host key verification against `~/.ssh/known_hosts` (shared with OpenSSH): asks on first connect, refuses changed keys
- Jump hosts, startup command per host
- Keepalive + latency in the status bar; automatic reconnect with backoff when the connection drops
- Tabs, command palette (`Ctrl+Shift+P`) with quick connect (`user@host:port`)
- ~75 built-in snippets with explanations (.NET, Docker, Compose, Node.js, PM2, Angular, React, Nginx, systemd, Git, Go) — catalog in `snippets.go`. Commands can use `{{name}}` / `{{name:default}}` placeholders; Termora asks for the values before running and remembers them. Click a snippet in the sidebar for its details
- **Split panes**: split right/down (`Alt+Shift+=` / `Alt+Shift+-` / `Alt+Shift+D`), drag dividers, `Alt+Arrows` to move, zoom a pane (`Ctrl+Shift+Z`), broadcast typing to all panes (`Ctrl+Shift+A`); palette `Shift+Enter` opens a host or shell in a split
- **Local terminals** via ConPTY: PowerShell 7, Windows PowerShell, Command Prompt, WSL, Git Bash (auto-detected); `Ctrl+Shift+`` opens the default one
- **Appearance** (`Ctrl+,`): 11 backgrounds (gradients and generated scenes) or your own image with darken/blur, 9 color schemes, font size — saved in the data file
- **Command history**: commands from every server and local shell are remembered; gray suggestions while typing (`→` accepts, `Ctrl+→` one word), `↑` at a prompt opens a searchable list (this server first), History tab in the sidebar. Passwords typed at no-echo prompts, lines starting with a space and commands containing `password=`/`--token` etc. are never stored
- **Explorer integration**: right-click a folder, inside a folder, a drive or a file → *Open in Termora* opens a local terminal there; a running Termora opens it as a new tab (single instance). `Termora.exe --cwd <folder>` does the same from scripts
- Find in scrollback, clickable links, Windows-Terminal-style copy/paste (`Ctrl+C` with selection, `Ctrl+V`, right-click), zoom

## Layout

| Path | What |
|---|---|
| `main.go` | Wails window setup |
| `app.go` | Bound API: hosts, snippets, key picker |
| `ssh.go` | Sessions: dial (incl. jump host), auth chain, PTY, output pump, keepalive |
| `hostkeys.go` | known_hosts verification |
| `sshconfig.go` | `~/.ssh/config` import |
| `store.go` / `secrets.go` | JSON store in `%APPDATA%\Termora`, secrets in the OS keyring |
| `frontend/src/terminal.ts` | `TermSession`: xterm + connection lifecycle, reconnect, clipboard |
| `frontend/src/App.tsx` | Layout, tabs, shortcuts, dialogs |

## Next phases

3. SFTP side panel, port-forwarding UI
4. Server dashboard (CPU/RAM/disk, Docker & systemd actions), themes
