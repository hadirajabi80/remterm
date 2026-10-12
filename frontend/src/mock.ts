import type { ConnectRequest } from './api';
import type { Host, Snippet } from './types';

/** Browser-only fake backend: echoes input like a tiny shell. */
export function installMock() {
  const listeners = new Map<string, Set<(...a: any[]) => void>>();
  const emit = (name: string, ...data: any[]) => listeners.get(name)?.forEach((cb) => cb(...data));
  const enc = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const id = () => Math.random().toString(16).slice(2, 10);
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const base = { port: 22, authMethod: 'auto', keyPath: '', jumpHostId: '', startupCommand: '', hasSecret: false, lastUsed: 0 };
  let hosts: Host[] = [
    { ...base, id: id(), name: 'api-prod-1', group: 'Production', env: 'prod', address: '10.0.1.12', user: 'deploy' },
    { ...base, id: id(), name: 'web-staging', group: 'Staging', env: 'staging', address: 'staging.example.com', user: 'ubuntu' },
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
}
