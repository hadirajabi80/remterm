export const meta = {
  name: 'qa-team',
  description: 'QA team (app, UX, UI, one per feature; Sonnet/Opus) tests Remterm, Fable triages and dispatches fixer subagents, then Fable reviews the fixes',
  whenToUse: 'Full QA pass over Remterm with automatic bug fixing',
  phases: [
    { title: 'QA', detail: 'app-wide, UX, UI and per-feature testers (Sonnet + Opus)' },
    { title: 'Triage', detail: 'Fable verifies, dedups and plans fix groups', model: 'fable' },
    { title: 'Fix', detail: 'fixer subagents, one per file-disjoint group' },
    { title: 'Review', detail: 'Fable reviews the diff and runs builds/tests', model: 'fable' },
  ],
}

const CONTEXT = `Project: Remterm (D:\\Projects\\Remterm) — a desktop remote-terminal app. Go backend (Wails-style, root *.go), React/TypeScript frontend (frontend/src, has a mock mode: mock.ts / mockRdp.ts), and a C# .NET RDP engine (rdp/engine, RemtermRdp.csproj) with credential auto-fill/auto-type into RDP sessions. Platform: Windows (PowerShell + Git Bash available).
Useful checks (read-only, safe to run): "go vet ./...", "go test ./...", "npm --prefix frontend run typecheck", "dotnet build rdp/engine/RemtermRdp.csproj -nologo -v q".
You are a QA TESTER: DO NOT edit, create or delete any project files, do not commit. Read code, run the checks above, reason about real user flows and edge cases. Report only concrete, evidenced problems (file + line, why it breaks, how to reproduce). No style nitpicks. Quality over quantity: a few real bugs beat many speculative ones.`

const FINDINGS = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: { type: 'string', enum: ['bug', 'security', 'ux', 'ui', 'performance', 'reliability'] },
          files: { type: 'array', items: { type: 'string' }, description: 'path:line references' },
          evidence: { type: 'string' },
          repro: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        required: ['title', 'severity', 'category', 'files', 'evidence', 'repro', 'suggestedFix'],
      },
    },
  },
  required: ['summary', 'findings'],
}

const TESTERS = [
  { key: 'app', model: 'opus', focus: 'Whole-app QA: end-to-end flows across features (first launch, add host, connect SSH/RDP/local, tabs, files, vault unlock, settings, update), cross-feature interactions, error handling, state persistence (store.go), crashes, races, resource leaks. Run all the checks listed above and report any failures.' },
  { key: 'ux', model: 'opus', focus: 'UX review: flows, discoverability, confusing wording, missing feedback/errors, keyboard shortcuts, focus handling, dialogs that lose input, destructive actions without confirmation, empty/loading/error states. Files: frontend/src/App.tsx, frontend/src/components/*.tsx. You may open the UI in mock mode: use the built-in browser preview_start with name "remterm-ui" (open your own tab), but if browser tools are unavailable just review the code.' },
  { key: 'ui', model: 'sonnet', focus: 'UI review: layout bugs, overflow/clipping, light/dark theme contrast (themes.ts, colors.ts, styles.css), inconsistent spacing/icons, broken states at small window sizes, RTL/Persian text rendering in terminal & dialogs. Files: frontend/src/styles.css, themes.ts, components/*.tsx, rdp/engine/UI/Theme.cs. You may use the built-in browser preview_start with name "remterm-ui" (open your own tab) in mock mode; otherwise review code.' },
  { key: 'ssh-terminal', model: 'opus', focus: 'SSH terminal: ssh.go, dial.go, hostkeys.go, agent_windows.go, agent_unix.go, frontend/src/terminal.ts, components/TermView.tsx, FindBar.tsx. Host key verification, auth methods, reconnect, resize, encoding, copy/paste.' },
  { key: 'history-autosuggest', model: 'sonnet', focus: 'Command history & gray autosuggest: cmdhistory.go, history.go, frontend/src/history.ts, autocomplete.ts, components/HistoryList.tsx, terminal.ts onKey. Prompt detection, accept with Right / Ctrl+Right, wrapped lines, secrets accidentally saved to history.' },
  { key: 'sftp-files', model: 'opus', focus: 'SFTP / file browser & transfers: files.go, frontend/src/transfers.ts, components/FilePanel.tsx, SftpView.tsx, rdp/engine/UI/MiniFsBar.cs. Path handling, overwrite, large files, cancel, permissions, Windows vs unix paths.' },
  { key: 'rdp-autofill', model: 'opus', focus: 'RDP sessions & credential auto-fill/auto-type: rdp/engine/** (SessionView.cs, KeyTyper.cs, PromptDetector.cs, ScreenReader.cs, CredentialPicker.cs, SessionWindow.cs, Host/*), rdp_windows.go, rdpproxy.go, frontend components RdpPanel/RdpDialogs/RdpView/WebRdpView/FillPicker.tsx. Keyboard layout, CapsLock/modifier states, clipboard fallback leaking passwords, focus races, WALLIX/bastion two-step login.' },
  { key: 'vault-secrets', model: 'opus', focus: 'Vault, secrets & keychain: vault.go, secrets.go, keychain.go, rdp/engine/Security/Vault.cs, components/VaultDialogs.tsx. Crypto misuse, secrets in logs/diag/clipboard/memory, lock/unlock, auto-lock, wrong-password handling.' },
  { key: 'hosts-connections', model: 'sonnet', focus: 'Host & connection management: store.go, sshconfig.go, protocols.go, launch.go, putty_windows.go, components/HostDialog.tsx, Sidebar.tsx, ConnectionsPanel.tsx, Welcome.tsx. Add/edit/delete/import hosts, favorites, groups, validation, ssh config parsing.' },
  { key: 'snippets', model: 'sonnet', focus: 'Snippets: snippets.go, components/SnippetDialog.tsx, SnippetInfo.tsx, SnippetVarsDialog.tsx. Variable substitution, escaping, running in the right tab, multi-line.' },
  { key: 'tunnels', model: 'sonnet', focus: 'Tunnels / port forwarding: tunnels.go and its UI. Port conflicts, start/stop, reconnect, leaks of goroutines/listeners, binding to 0.0.0.0 unintentionally.' },
  { key: 'local-shell-tabs', model: 'sonnet', focus: 'Local shells & tabs/panes: local_windows.go, local_unix.go, shellmenu_windows.go, cli_windows.go, components/TabBar.tsx, TabPanes.tsx, TabDrop.tsx, TabPreview.tsx, layout.ts. Split panes, drag/drop, closing tabs with running sessions, shell detection.' },
  { key: 'session-logs', model: 'sonnet', focus: 'Session logging: sessionlog.go, components/LogView.tsx. Passwords captured in logs, file growth, rotation, encoding.' },
  { key: 'update-installer', model: 'opus', focus: 'Auto-update & installer: update.go, update_windows.go, update_darwin.go, update_other.go, components/UpdateBanner.tsx, installer/*, build.ps1, .github/workflows/build.yml. Version compare, download integrity/signature checks, failure messages, release with no installer.' },
  { key: 'palette-settings', model: 'sonnet', focus: 'Command palette, settings & status: components/CommandPalette.tsx, AppearancePanel.tsx, StatusBar.tsx, Menu.tsx, Modal.tsx, fields.tsx, panels.tsx. Settings persistence/defaults, shortcuts conflicts, modal escape/focus trap.' },
]

phase('QA')
log(`${TESTERS.length} QA testers starting`)
const reports = (await parallel(TESTERS.map(t => () =>
  agent(`${CONTEXT}\n\nYour QA assignment (${t.key}):\n${t.focus}`, {
    label: `qa:${t.key} (${t.model})`, phase: 'QA', model: t.model, schema: FINDINGS,
  }).then(r => r && ({ tester: t.key, model: t.model, ...r }))
))).filter(Boolean)
const total = reports.reduce((n, r) => n + r.findings.length, 0)
log(`QA done: ${total} findings from ${reports.length}/${TESTERS.length} testers`)
if (!total) return { reports, note: 'No findings — nothing to fix.' }

phase('Triage')
const TRIAGE = {
  type: 'object',
  properties: {
    confirmed: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          files: { type: 'array', items: { type: 'string' } },
          rootCause: { type: 'string' }, fixPlan: { type: 'string' },
          reportedBy: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'severity', 'files', 'rootCause', 'fixPlan', 'reportedBy'],
      },
    },
    groups: {
      type: 'array',
      description: 'Fix groups for subagents. Groups MUST NOT share any file. All C# (rdp/engine) changes go in ONE group.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          bugIds: { type: 'array', items: { type: 'string' } },
          instructions: { type: 'string' },
        },
        required: ['name', 'files', 'bugIds', 'instructions'],
      },
    },
    rejected: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' } }, required: ['title', 'reason'] } },
    deferred: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' } }, required: ['title', 'reason'] } },
  },
  required: ['confirmed', 'groups', 'rejected', 'deferred'],
}
const triage = await agent(
  `${CONTEXT.split('You are a QA TESTER')[0]}
You are the QA LEAD. Below are reports from ${reports.length} QA testers. Do NOT edit files in this step.
1. Verify each finding against the actual code (open the files). Reject false positives, speculation and pure nitpicks with a reason.
2. Merge duplicates (record every tester in reportedBy).
3. Defer anything that needs a product decision, a large redesign, or is too risky to change automatically.
4. For the confirmed bugs, plan fix groups for fixer subagents that will run IN PARALLEL in the same working tree: groups must touch disjoint files; put every rdp/engine C# change in a single group. Give each group precise instructions (what to change and why, matching the surrounding code style, minimal diffs).

Reports (JSON):
${JSON.stringify(reports, null, 1)}`,
  { label: 'triage (fable)', phase: 'Triage', model: 'fable', schema: TRIAGE })
if (!triage) return { reports, note: 'Triage agent failed.' }
log(`Triage: ${triage.confirmed.length} confirmed, ${triage.rejected.length} rejected, ${triage.deferred.length} deferred, ${triage.groups.length} fix groups`)
if (!triage.groups.length) return { reports, triage }

phase('Fix')
const FIXED = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'object', properties: { bugId: { type: 'string' }, change: { type: 'string' } }, required: ['bugId', 'change'] } },
    notFixed: { type: 'array', items: { type: 'object', properties: { bugId: { type: 'string' }, reason: { type: 'string' } }, required: ['bugId', 'reason'] } },
    filesChanged: { type: 'array', items: { type: 'string' } },
  },
  required: ['fixed', 'notFixed', 'filesChanged'],
}
const byId = Object.fromEntries(triage.confirmed.map(b => [b.id, b]))
const fixes = (await parallel(triage.groups.map(g => () =>
  agent(`You are a fixer subagent for Remterm (D:\\Projects\\Remterm). Other fixers are editing OTHER files in the same working tree at the same time, so edit ONLY these files: ${g.files.join(', ')}.
Do not commit, do not touch git state. Keep diffs minimal and match the surrounding code's style and comment density.
${g.files.some(f => f.includes('rdp')) ? 'You own the C# engine: verify with "dotnet build rdp/engine/RemtermRdp.csproj -nologo -v q".' : 'Do NOT run dotnet build (another fixer owns it). Verify Go with "go vet ./..." and TS with "npm --prefix frontend run typecheck" as relevant.'}
If a fix turns out wrong or risky, leave it and report it in notFixed.

Group: ${g.name}
Lead's instructions: ${g.instructions}

Bugs:
${JSON.stringify(g.bugIds.map(id => byId[id] || { id }), null, 1)}`,
    { label: `fix:${g.name}`, phase: 'Fix', model: 'opus', schema: FIXED })
    .then(r => r && ({ group: g.name, ...r }))
))).filter(Boolean)
log(`Fixers done: ${fixes.reduce((n, f) => n + f.fixed.length, 0)} fixed, ${fixes.reduce((n, f) => n + f.notFixed.length, 0)} not fixed`)

phase('Review')
const review = await agent(
  `You are the QA LEAD reviewing your fixer subagents' work on Remterm (D:\\Projects\\Remterm). Run "git diff" to see all changes.
1. Check each change actually fixes its bug and introduces no regression.
2. Run: "go vet ./...", "go test ./...", "npm --prefix frontend run typecheck", "dotnet build rdp/engine/RemtermRdp.csproj -nologo -v q".
3. If a change is wrong or breaks a build/test, fix it yourself (minimal edit) or revert that hunk. Do not commit.
Return a concise markdown report: build/test results, each bug and its final status, anything reverted, and the remaining deferred items.

Confirmed bugs: ${JSON.stringify(triage.confirmed.map(b => ({ id: b.id, title: b.title, severity: b.severity })))}
Fixer results: ${JSON.stringify(fixes)}
Deferred: ${JSON.stringify(triage.deferred)}`,
  { label: 'review (fable)', phase: 'Review', model: 'fable' })

return {
  testers: reports.map(r => ({ tester: r.tester, model: r.model, findings: r.findings.length, summary: r.summary })),
  confirmed: triage.confirmed,
  rejected: triage.rejected,
  deferred: triage.deferred,
  fixes,
  review,
}