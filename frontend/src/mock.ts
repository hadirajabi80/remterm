import type { ConnectRequest } from './api';
import type { FileEntry, Host, Snippet } from './types';
import { createRdpMock } from './mockRdp';

/** Browser-only fake backend: echoes input like a tiny shell. */
export function installMock() {
  const listeners = new Map<string, Set<(...a: any[]) => void>>();
  const emit = (name: string, ...data: any[]) => listeners.get(name)?.forEach((cb) => cb(...data));
  const enc = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const id = () => Math.random().toString(16).slice(2, 10);
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const base = {
    port: 22,
    authMethod: 'auto',
    keyPath: '',
    jumpHostId: '',
    startupCommand: '',
    hasSecret: false,
    lastUsed: 0,
    protocol: 'ssh',
    tags: [] as string[],
    keyId: '',
    identityId: '',
    agentForwarding: false,
    envVars: [],
    proxy: null,
    scheme: '',
    serial: null,
  };
  let hosts: Host[] = [
    { ...base, id: id(), name: 'api-prod-1', group: 'Clients/Acme/Production', env: 'prod', address: '10.0.1.12', user: 'deploy', tags: ['docker', 'dotnet'] },
    { ...base, id: id(), name: 'db-prod', group: 'Clients/Acme/Production', env: 'prod', address: '10.0.1.20', user: 'deploy', tags: ['postgres'] },
    { ...base, id: id(), name: 'web-staging', group: 'Clients/Acme/Staging', env: 'staging', address: 'staging.example.com', user: 'ubuntu', tags: ['nginx', 'node'] },
    { ...base, id: id(), name: 'core-switch', group: 'Network', env: '', address: '10.0.0.2', user: 'admin', protocol: 'telnet', port: 23 },
    { ...base, id: id(), name: 'dev-box', group: '', env: 'dev', address: '192.168.1.50', user: 'hadi', port: 2222 },
  ];
  let snippets: Snippet[] = [
    { id: id(), group: 'System', name: 'Disk usage', command: 'df -h', description: 'Used and free space of every mounted filesystem.' },
    {
      id: id(),
      group: 'Docker',
      name: 'Running containers',
      command: "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}'",
      description: 'Compact table of running containers with image, uptime/health and published ports.',
    },
    {
      id: id(),
      group: 'Docker',
      name: 'Follow container logs',
      command: 'docker logs -f --tail 200 {{container}}',
      description: "Streams a container's stdout/stderr, starting with the last 200 lines.",
    },
    {
      id: id(),
      group: '.NET',
      name: 'Restart API service',
      command: 'sudo systemctl restart {{service:myapi}} && journalctl -u {{service:myapi}} -n 50 --no-pager',
      description: 'Restarts the systemd unit hosting your ASP.NET Core app and prints its last 50 log lines.',
    },
    {
      id: id(),
      group: 'Angular',
      name: 'Deploy build to nginx',
      command: 'sudo rsync -a --delete dist/{{project}}/browser/ /var/www/{{site}}/ && sudo systemctl reload nginx',
      description: 'Copies the build into the web root, removing stale files, then reloads nginx.',
    },
  ];
  const sessions = new Map<string, { prompt: string; line: string }>();
  const ago = (min: number) => Date.now() - min * 60_000;
  let explorerMenu = false;
  let cmdHistory = [
    { command: 'docker compose ps', hostKey: 'ssh:' + hosts[0].id, count: 4, lastUsed: ago(300) },
    { command: 'docker compose logs -f --tail=200 api', hostKey: 'ssh:' + hosts[0].id, count: 2, lastUsed: ago(90) },
    { command: 'sudo systemctl restart myapi', hostKey: 'ssh:' + hosts[0].id, count: 6, lastUsed: ago(30) },
    { command: 'journalctl -u myapi -f -n 200', hostKey: 'ssh:' + hosts[0].id, count: 3, lastUsed: ago(25) },
    { command: 'git pull --ff-only', hostKey: 'ssh:' + hosts[1].id, count: 5, lastUsed: ago(60) },
    { command: 'npm run build', hostKey: 'ssh:' + hosts[1].id, count: 8, lastUsed: ago(58) },
    { command: 'dotnet publish -c Release -o ./publish', hostKey: 'local:pwsh', count: 2, lastUsed: ago(1440) },
    { command: 'df -h', hostKey: 'ssh:' + hosts[2].id, count: 9, lastUsed: ago(10) },
  ];

  window.runtime = {
    EventsOn(name, cb) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(cb);
      return () => listeners.get(name)?.delete(cb);
    },
    ClipboardGetText: async () => (await navigator.clipboard?.readText?.().catch(() => '')) ?? '',
    ClipboardSetText: async (t) => {
      await navigator.clipboard?.writeText(t).catch(() => {});
      return true;
    },
    BrowserOpenURL: (u) => window.open(u, '_blank'),
  };

  window.go = {
    main: {
      App: {
        ListHosts: async () => hosts,
        SaveHost: async (h: Host, secret: string) => {
          const saved = { ...h, id: h.id || id(), hasSecret: h.hasSecret || !!secret };
          hosts = hosts.some((x) => x.id === saved.id) ? hosts.map((x) => (x.id === saved.id ? saved : x)) : [...hosts, saved];
          return saved;
        },
        DeleteHost: async (hid: string) => void (hosts = hosts.filter((h) => h.id !== hid)),
        ClearSecret: async () => {},
        PickKeyFile: async () => '~/.ssh/id_ed25519',
        ImportSSHConfig: async () => 0,
        ListSnippets: async () => snippets,
        SaveSnippet: async (s: Snippet) => {
          const saved = { ...s, id: s.id || id() };
          snippets = snippets.some((x) => x.id === saved.id) ? snippets.map((x) => (x.id === saved.id ? saved : x)) : [...snippets, saved];
          return saved;
        },
        DeleteSnippet: async (sid: string) => void (snippets = snippets.filter((s) => s.id !== sid)),
        Connect: async (req: ConnectRequest) => {
          await delay(500);
          let saved = false;
          let h = hosts.find((x) => x.id === req.hostId);
          if (!h && req.spec) {
            const m = req.spec.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/)!;
            const spec = { user: m[1] || 'root', address: m[2], port: Number(m[3]) || 22 };
            h = hosts.find((x) => x.address === spec.address && x.port === spec.port && x.user === spec.user);
            if (!h) {
              h = { ...base, ...spec, id: id(), name: spec.address, group: 'Quick connect', env: '', lastUsed: 0 };
              hosts = [...hosts, h];
              saved = true;
            }
          }
          if (h) h.lastUsed = Date.now();
          const user = h?.user || 'root';
          const host = h?.name || req.spec;
          const prompt = `\x1b[1;32m${user}@${host}\x1b[0m:\x1b[1;34m~\x1b[0m$ `;
          sessions.set(req.sessionId, { prompt, line: '' });
          setTimeout(() => {
            emit('term:data', req.sessionId, enc(`Welcome to Ubuntu 24.04 LTS (demo mode — no real SSH)\r\n\r\n${prompt}`));
            emit('term:latency', req.sessionId, 24);
          }, 30);
          return { hostId: h?.id ?? '', saved };
        },
        Write: async (sid: string, data: string) => {
          const s = sessions.get(sid);
          if (!s) throw 'session closed';
          let out = '';
          for (const ch of data) {
            if (ch === '\r') {
              if (s.line.trim() === 'exit') {
                sessions.delete(sid);
                emit('term:data', sid, enc(out + '\r\n'));
                emit('term:closed', sid, 'Process exited (code 0)', false, 0);
                return;
              }
              out += `\r\n${s.line ? `mock: ${s.line}\r\n` : ''}${s.prompt}`;
              s.line = '';
            } else if (ch === '\x7f') {
              if (s.line) {
                s.line = s.line.slice(0, -1);
                out += '\b \b';
              }
            } else if (ch >= ' ') {
              s.line += ch;
              out += ch;
            }
          }
          emit('term:data', sid, enc(out));
        },
        Resize: async () => {},
        Disconnect: async (sid: string) => {
          if (sessions.delete(sid)) emit('term:closed', sid, 'Disconnected', false, -1);
        },
        ListShells: async () => [
          { id: 'pwsh', name: 'PowerShell 7', command: 'pwsh.exe' },
          { id: 'powershell', name: 'Windows PowerShell', command: 'powershell.exe' },
          { id: 'cmd', name: 'Command Prompt', command: 'cmd.exe' },
          { id: 'wsl', name: 'WSL', command: 'wsl.exe' },
        ],
        OpenLocal: async (req: { sessionId: string; shellId: string }) => {
          await delay(150);
          const prompt = req.shellId === 'cmd' ? 'C:\\Users\\hadi>' : req.shellId === 'wsl' ? '\x1b[1;32mhadi@DESKTOP\x1b[0m:\x1b[1;34m~\x1b[0m$ ' : 'PS C:\\Users\\hadi> ';
          sessions.set(req.sessionId, { prompt, line: '' });
          const banner = req.shellId.includes('powershell') || req.shellId === 'pwsh' ? 'PowerShell 7.4.6 (demo mode)\r\n' : '';
          setTimeout(() => emit('term:data', req.sessionId, enc(banner + prompt)), 20);
        },
        TakeLaunchFolder: async () => '',
        ExplorerMenuEnabled: async () => explorerMenu,
        SetExplorerMenu: async (on: boolean) => {
          explorerMenu = on;
        },
        ListCommandHistory: async () => cmdHistory,
        AddCommandHistory: async (command: string, hostKey: string) => {
          const e = cmdHistory.find((x) => x.command === command && x.hostKey === hostKey);
          if (e) {
            e.count++;
            e.lastUsed = Date.now();
          } else cmdHistory.push({ command, hostKey, count: 1, lastUsed: Date.now() });
        },
        DeleteCommandHistory: async (command: string) => {
          cmdHistory = cmdHistory.filter((e) => e.command !== command);
        },
        ClearCommandHistory: async () => {
          cmdHistory = [];
        },
        GetSettings: async () => {
          try {
            return localStorage.getItem('mockSettings') ?? '';
          } catch {
            return '';
          }
        },
        SaveSettings: async (raw: string) => {
          try {
            localStorage.setItem('mockSettings', raw);
          } catch {
            /* storage unavailable */
          }
        },
      },
    },
  };

  // ---------- vault, tunnels, logs, files ----------
  const groups = [
    { path: 'Clients/Acme/Production', identityId: '', jumpHostId: '', startupCommand: '', envVars: [], proxy: null, agentForwarding: false, scheme: 'dracula' },
  ];
  const keys = [
    {
      id: id(),
      label: 'work laptop',
      type: 'ssh-ed25519',
      publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheDemoOnly0123456789abcdef work_laptop',
      fingerprint: 'SHA256:q3Z0demoFingerprint9xYcQm1B2s7k',
      encrypted: false,
      hasPassphrase: false,
      certificate: '',
      created: ago(60 * 24 * 30),
    },
  ];
  const identities = [{ id: id(), label: 'deploy (prod)', username: 'deploy', keyId: keys[0].id, hasPassword: true }];
  const tunnels = [
    { id: id(), label: 'Postgres (prod)', type: 'local', hostId: hosts[1].id, bindAddress: '', port: 5433, destHost: '127.0.0.1', destPort: 5432, autoStart: false },
    { id: id(), label: 'SOCKS via api', type: 'dynamic', hostId: hosts[0].id, bindAddress: '', port: 1080, destHost: '', destPort: 0, autoStart: true },
  ];
  const tstatus: Record<string, { id: string; state: string; error: string; conns: number }> = {
    [tunnels[1].id]: { id: tunnels[1].id, state: 'running', error: '', conns: 2 },
  };
  let workspaces: { id: string; name: string; data: unknown }[] = [];
  const logs = [
    { id: id(), hostKey: 'ssh:' + hosts[0].id, title: 'api-prod-1', started: ago(45), ended: ago(30), size: 18234, bookmarked: true, comment: 'DB migration' },
    { id: id(), hostKey: 'ssh:' + hosts[2].id, title: 'web-staging', started: ago(200), ended: ago(190), size: 4210, bookmarked: false, comment: '' },
  ];
  const fsTree: Record<string, FileEntry[]> = {};
  const file = (dir: string, name: string, size: number, isDir = false, sep = '/'): FileEntry => ({
    name,
    path: dir.replace(/[\\/]$/, '') + sep + name,
    dir: isDir,
    link: false,
    size,
    mode: (isDir ? 'd' : '-') + 'rwxr-xr-x',
    perm: isDir ? 0o755 : 0o644,
    modified: ago(Math.random() * 5000),
  });
  fsTree['/home/deploy'] = [
    file('/home/deploy', 'app', 0, true),
    file('/home/deploy', '.bashrc', 3771),
    file('/home/deploy', 'docker-compose.yml', 1288),
    file('/home/deploy', 'backup-2026-10-01.sql.gz', 48_211_002),
  ];
  fsTree['/home/deploy/app'] = [file('/home/deploy/app', 'appsettings.json', 2201), file('/home/deploy/app', 'MyApi.dll', 812_000)];
  fsTree['C:\\Users\\hadi'] = [
    file('C:\\Users\\hadi', 'Desktop', 0, true, '\\'),
    file('C:\\Users\\hadi', 'Downloads', 0, true, '\\'),
    file('C:\\Users\\hadi', 'site.zip', 5_120_331, false, '\\'),
    file('C:\\Users\\hadi', 'notes.txt', 912, false, '\\'),
  ];
  const parentOf = (p: string) => (p.includes('\\') ? p.replace(/\\[^\\]*$/, '') || 'C:\\' : p.replace(/\/[^/]*$/, '') || '/');

  Object.assign(window.go.main.App, {
    ListGroups: async () => groups,
    SaveGroup: async (g: (typeof groups)[0]) => {
      const i = groups.findIndex((x) => x.path === g.path);
      if (i >= 0) groups[i] = g;
      else groups.push(g);
      return g;
    },
    RenameGroup: async () => {},
    DeleteGroup: async () => {},
    ListIdentities: async () => identities,
    SaveIdentity: async (i: (typeof identities)[0]) => {
      const saved = { ...i, id: i.id || id() };
      const at = identities.findIndex((x) => x.id === saved.id);
      if (at >= 0) identities[at] = saved;
      else identities.push(saved);
      return saved;
    },
    ClearIdentityPassword: async () => {},
    DeleteIdentity: async () => {},
    ListKeys: async () => keys,
    GenerateKey: async (r: { label: string; type: string }) => {
      await delay(300);
      const k = { ...keys[0], id: id(), label: r.label || 'new key', type: r.type === 'rsa' ? 'ssh-rsa' : r.type === 'ecdsa' ? 'ecdsa-sha2-nistp256' : 'ssh-ed25519', created: Date.now() };
      keys.push(k);
      return k;
    },
    ImportKey: async () => keys[0],
    UpdateKey: async (kid: string, label: string, cert: string) => Object.assign(keys.find((k) => k.id === kid)!, { label, certificate: cert }),
    SetKeyPassphrase: async () => {},
    DeleteKey: async () => {},
    ExportKeyToHost: async () => {
      await delay(500);
    },
    ListTunnels: async () => tunnels,
    SaveTunnel: async (t: (typeof tunnels)[0]) => {
      const saved = { ...t, id: t.id || id(), label: t.label || `${t.port} → ${t.destHost}:${t.destPort}` };
      const at = tunnels.findIndex((x) => x.id === saved.id);
      if (at >= 0) tunnels[at] = saved;
      else tunnels.push(saved);
      return saved;
    },
    DeleteTunnel: async () => {},
    StartTunnel: async (tid: string) => {
      emit('tunnel:status', (tstatus[tid] = { id: tid, state: 'starting', error: '', conns: 0 }));
      await delay(400);
      emit('tunnel:status', (tstatus[tid] = { id: tid, state: 'running', error: '', conns: 0 }));
    },
    StopTunnel: async (tid: string) => emit('tunnel:status', (tstatus[tid] = { id: tid, state: 'stopped', error: '', conns: 0 })),
    TunnelStatuses: async () => Object.values(tstatus),
    ListWorkspaces: async () => workspaces,
    SaveWorkspace: async (w: { id: string; name: string; data: unknown }) => {
      const saved = { ...w, id: w.id || id() };
      workspaces = [...workspaces.filter((x) => x.id !== saved.id), saved];
      return saved;
    },
    DeleteWorkspace: async (wid: string) => void (workspaces = workspaces.filter((w) => w.id !== wid)),
    ListLogs: async () => logs,
    ReadLog: async () => enc('\x1b[1;32mdeploy@api-prod-1\x1b[0m:~$ sudo systemctl restart myapi\r\n\x1b[1;32mdeploy@api-prod-1\x1b[0m:~$ journalctl -u myapi -n 3\r\nOct 12 10:01 api[811]: \x1b[32mNow listening on: http://0.0.0.0:5000\x1b[0m\r\n'),
    SetLogBookmark: async (lid: string, b: boolean, c: string) => Object.assign(logs.find((l) => l.id === lid)!, { bookmarked: b, comment: c }),
    DeleteLog: async () => {},
    ExportLog: async () => '',
    SetLogging: async () => {},
    ListKnownHosts: async () => [
      { line: 1, hosts: '10.0.1.12', keyType: 'ssh-ed25519', fingerprint: 'SHA256:abcDEFdemo0123456789xyz', marker: '' },
      { line: 2, hosts: 'staging.example.com', keyType: 'ecdsa-sha2-nistp256', fingerprint: 'SHA256:zyxDemoFingerprint9876', marker: '' },
    ],
    RemoveKnownHost: async () => {},
    ListSerialPorts: async () => ['COM3', 'COM4'],
    ImportPuTTY: async () => 0,
    OpenSftp: async () => {
      await delay(300);
      return '/home/deploy';
    },
    CloseSftp: async () => {},
    FsHome: async (fsId: string) => (fsId === 'local' ? 'C:\\Users\\hadi' : '/home/deploy'),
    FsList: async (_fs: string, dir: string) => {
      await delay(80);
      return [...(fsTree[dir] ?? [])];
    },
    FsParent: async (_fs: string, p: string) => parentOf(p),
    FsMkdir: async (_fs: string, p: string) => {
      const dir = parentOf(p);
      (fsTree[dir] ??= []).push(file(dir, p.split(/[\\/]/).pop()!, 0, true, p.includes('\\') ? '\\' : '/'));
    },
    FsRename: async () => {},
    FsDelete: async (_fs: string, paths: string[]) => {
      for (const p of paths) {
        const dir = parentOf(p);
        fsTree[dir] = (fsTree[dir] ?? []).filter((e) => e.path !== p);
      }
    },
    FsChmod: async () => {},
    FsOpen: async () => {},
    CancelTransfer: async () => {},
    FsTransfer: async (req: { srcFs: string; paths: string[]; dstFs: string; dstDir: string }) => {
      const tid = id();
      const total = 3_000_000;
      let done = 0;
      const label = req.paths[0].split(/[\\/]/).pop()!;
      const timer = setInterval(() => {
        done = Math.min(total, done + 400_000);
        const finished = done >= total;
        if (finished) {
          clearInterval(timer);
          const sep = req.dstDir.includes('\\') ? '\\' : '/';
          (fsTree[req.dstDir] ??= []).push(file(req.dstDir, label, total, false, sep));
        }
        emit('fs:transfer', { id: tid, state: finished ? 'done' : 'running', label, file: label, filesDone: finished ? 1 : 0, filesTotal: 1, bytesDone: done, bytesTotal: total, error: '' });
      }, 150);
      return tid;
    },
  });
  Object.assign(window.go.main.App, createRdpMock(emit));
}
