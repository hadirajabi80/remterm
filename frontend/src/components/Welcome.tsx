import { useState } from 'react';
import { lastUsedMs, machineDetail, RDP_HOST_RE } from '../rdp';
import type { Host, LocalShell, Machine } from '../types';
import { byRecent, hostLabel, looksLikeSpec, timeAgo } from '../util';
import { Icon } from './Icon';

const SHORTCUTS: [string, string][] = [
  ['Command palette', 'Ctrl+Shift+P'],
  ['New connection', 'Ctrl+Shift+T'],
  ['Close pane / tab', 'Ctrl+Shift+W'],
  ['Split right / down', 'Alt+Shift+= / −'],
  ['Move between panes', 'Alt+Arrows'],
  ['Local terminal', 'Ctrl+Shift+`'],
  ['Next / previous tab', 'Ctrl+Tab'],
  ['Go to tab 1–9', 'Ctrl+1…9'],
  ['Find in terminal', 'Ctrl+Shift+F'],
  ['Reconnect', 'Ctrl+Shift+R'],
  ['Copy / paste', 'Ctrl+C / Ctrl+V'],
  ['Zoom in / out / reset', 'Ctrl + / − / 0'],
  ['Toggle sidebar', 'Ctrl+Shift+B'],
];

const RDP_SHORTCUTS: [string, string][] = [
  ['Fill a saved login', 'Ctrl+Alt+K'],
  ['Fullscreen on / off', 'Ctrl+Alt+Enter'],
  ['Next / previous tab', 'Ctrl+Alt+PgDn / PgUp'],
  ['Quick connect', 'Ctrl+Alt+P'],
  ['Reconnect / close', 'Ctrl+Alt+R / W'],
  ['Lock', 'Ctrl+Alt+L'],
];

export function Welcome(props: {
  hosts: Host[];
  shells: LocalShell[];
  machines: Machine[] | null; // null: Remote Desktop not available / not unlocked
  onLocal(shellId: string): void;
  onConnect(h: Host): void;
  onQuickConnect(spec: string): void;
  onQuickRdp?(host: string): void;
  onRdp(m: Machine): void;
  onNewHost(): void;
  onImport(): void;
  onRdpPanel(): void;
}) {
  const [spec, setSpec] = useState('');
  const q = spec.trim();
  const sshOk = looksLikeSpec(q);
  const rdpOk = !!props.onQuickRdp && RDP_HOST_RE.test(q);
  const hosts = byRecent(props.hosts);
  const hasRecent = hosts.some((h) => h.lastUsed > 0);
  const machines = [...(props.machines ?? [])].sort((a, b) => lastUsedMs(b) - lastUsedMs(a) || Number(b.favorite) - Number(a.favorite));

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="hero">
          <h1>Connect to a server</h1>
          <p>SSH, Remote Desktop and local terminals in one window. Dropped connections reconnect automatically.</p>
        </div>

        <form
          className="quick"
          onSubmit={(e) => {
            e.preventDefault();
            if (sshOk) props.onQuickConnect(q.replace(/^ssh\s+/, ''));
            else if (rdpOk) props.onQuickRdp?.(q);
          }}
        >
          <Icon name="terminal" />
          <input autoFocus placeholder="user@host:port for SSH — or an IP for Remote Desktop" value={spec} onChange={(e) => setSpec(e.target.value)} spellCheck={false} />
          {props.onQuickRdp && (
            <button className="btn" type="button" disabled={!rdpOk} onClick={() => props.onQuickRdp?.(q)} title="Direct Remote Desktop (RDP)">
              <Icon name="monitor" size={14} /> RDP
            </button>
          )}
          <button className="btn primary" type="submit" disabled={!sshOk}>
            SSH
          </button>
        </form>

        {props.shells.length > 0 && (
          <>
            <div className="section-title">
              <span>Local terminals</span>
            </div>
            <div className="shell-row">
              {props.shells.map((s) => (
                <button key={s.id} className={`shell-btn shell-${s.id}`} onClick={() => props.onLocal(s.id)}>
                  <Icon name="terminal" size={14} />
                  {s.name}
                </button>
              ))}
            </div>
          </>
        )}

        {props.machines && (
          <>
            <div className="section-title">
              <span>Remote Desktop</span>
              <span className="section-actions">
                <button className="link" onClick={props.onRdpPanel}>
                  All machines →
                </button>
              </span>
            </div>
            {machines.length === 0 ? (
              <div className="empty-card">
                No machines yet. Open <button className="link" onClick={props.onRdpPanel}>Remote Desktop</button> in the sidebar to set up the WALLIX bastion and
                import your list — or type an IP above.
              </div>
            ) : (
              <div className="cards">
                {machines.slice(0, 6).map((m) => (
                  <button key={m.id} className="card" onClick={() => props.onRdp(m)}>
                    <span className={`host-ico rdp ${m.mode}`}>
                      <Icon name="monitor" size={15} />
                    </span>
                    <span className="card-main">
                      <span className="card-title">
                        {m.name}
                        {m.favorite ? ' ★' : ''}
                      </span>
                      <span className="card-sub">{machineDetail(m)}</span>
                      {m.lastUsed && <span className="card-time">{timeAgo(lastUsedMs(m))}</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        <div className="section-title">
          <span>{hasRecent ? 'Recent SSH' : 'SSH hosts'}</span>
          <span className="section-actions">
            <button className="link" onClick={props.onImport}>
              Import ~/.ssh/config
            </button>
            <button className="link" onClick={props.onNewHost}>
              + New host
            </button>
          </span>
        </div>
        {props.hosts.length === 0 ? (
          <div className="empty-card">
            No saved hosts yet. Add one, import your <code>~/.ssh/config</code>, or quick-connect above.
          </div>
        ) : (
          <div className="cards">
            {hosts.slice(0, 9).map((h) => (
              <button key={h.id} className="card" onClick={() => props.onConnect(h)}>
                <span className={`host-ico env-${h.env || 'none'}`}>
                  <Icon name="server" size={15} />
                </span>
                <span className="card-main">
                  <span className="card-title">{h.name}</span>
                  <span className="card-sub">{hostLabel(h)}</span>
                  {h.lastUsed > 0 && <span className="card-time">{timeAgo(h.lastUsed)}</span>}
                </span>
                {h.env && <span className={`mini-badge ${h.env}`}>{h.env.toUpperCase()}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="section-title">
          <span>Keyboard</span>
        </div>
        <div className="keys">
          {SHORTCUTS.map(([label, keys]) => (
            <div key={label}>
              <span>{label}</span>
              <kbd>{keys}</kbd>
            </div>
          ))}
        </div>
        {props.machines && (
          <>
            <div className="section-title">
              <span>Inside a Remote Desktop session</span>
            </div>
            <div className="keys">
              {RDP_SHORTCUTS.map(([label, keys]) => (
                <div key={label}>
                  <span>{label}</span>
                  <kbd>{keys}</kbd>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
