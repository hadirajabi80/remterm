import { useState, useSyncExternalStore } from 'react';
import { history } from '../history';
import type { GroupConfig, Host, Identity, KeyItem, Snippet, Tunnel, TunnelStatus, Workspace } from '../types';
import { buildGroupTree, groupBy, hostLabel, matches, timeAgo, type GroupNode } from '../util';
import { Icon } from './Icon';
import { colorCss, sshGroupKey } from '../colors';
import { Menu, type MenuEntry, type MenuItem } from './Menu';
import { KeychainPanel, KnownHostsPanel, LogsPanel, TunnelsPanel, WorkspacesPanel } from './panels';
import { RdpPanel, type RdpCtx } from './RdpPanel';
import { SnippetInfo } from './SnippetInfo';

export type Panel = 'hosts' | 'rdp' | 'snippets' | 'history' | 'keychain' | 'tunnels' | 'workspaces' | 'logs' | 'knownhosts';

/** Everything the sidebar sections show and can do. */
export interface SidebarCtx {
  hosts: Host[];
  groups: GroupConfig[];
  snippets: Snippet[];
  identities: Identity[];
  keys: KeyItem[];
  tunnels: Tunnel[];
  tunnelStatus: Record<string, TunnelStatus>;
  workspaces: Workspace[];
  hasSession: boolean;
  canSaveWorkspace: boolean;
  connect(h: Host, split?: boolean): void;
  openSftp(h: Host): void;
  editHost(h: Host | null, group?: string): void;
  duplicateHost(h: Host): void;
  deleteHost(h: Host): void;
  editGroup(path: string | null): void;
  connectGroup(path: string): void;
  importSSHConfig(): void;
  importPuTTY(): void;
  runSnippet(s: Snippet, execute: boolean): void;
  runSnippetOnHosts(s: Snippet): void;
  editSnippet(s: Snippet | null): void;
  deleteSnippet(s: Snippet): void;
  runHistory(command: string, execute: boolean): void;
  clearHistory(): void;
  historyHostLabel(key: string): string;
  generateKey(): void;
  importKey(): void;
  openKey(k: KeyItem): void;
  editIdentity(i: Identity | null): void;
  editTunnel(t: Tunnel | null): void;
  toggleTunnel(t: Tunnel): void;
  deleteTunnel(t: Tunnel): void;
  saveWorkspace(): void;
  openWorkspace(w: Workspace): void;
  renameWorkspace(w: Workspace): void;
  deleteWorkspace(w: Workspace): void;
  openLog(id: string, title: string): void;
  notify(text: string, kind?: 'info' | 'error'): void;
  /** Group colors ('ssh:<path>' -> color id). */
  colors: Record<string, string>;
  setColor(key: string, color: string | null): void;
}

const NAV: { id: Panel; icon: string; label: string }[] = [
  { id: 'hosts', icon: 'server', label: 'SSH hosts' },
  { id: 'rdp', icon: 'monitor', label: 'Remote Desktop' },
  { id: 'snippets', icon: 'code', label: 'Snippets' },
  { id: 'history', icon: 'clock', label: 'History' },
  { id: 'keychain', icon: 'key', label: 'Keychain' },
  { id: 'tunnels', icon: 'tunnel', label: 'Port forwarding' },
  { id: 'workspaces', icon: 'layout', label: 'Workspaces' },
  { id: 'logs', icon: 'file', label: 'Session logs' },
  { id: 'knownhosts', icon: 'shield', label: 'Known hosts' },
];

export function Sidebar(props: { ctx: SidebarCtx; rdp: RdpCtx; panel: Panel; onPanel(p: Panel): void; onSettings(): void }) {
  const { ctx, panel } = props;
  const running = Object.values(ctx.tunnelStatus).filter((s) => s.state === 'running').length;
  const rdpOpen = Object.values(props.rdp.openStatus).filter((s) => s === 'connected').length;
  return (
    <aside className="sidebar">
      <nav className="rail">
        <div className="brand-logo" title="Remterm">
          <Icon name="terminal" size={16} />
        </div>
        {NAV.map((n) => (
          <button key={n.id} className={`rail-btn ${panel === n.id ? 'on' : ''}`} title={n.label} onClick={() => props.onPanel(n.id)}>
            <Icon name={n.icon} size={18} />
            {n.id === 'tunnels' && running > 0 && <span className="rail-badge">{running}</span>}
            {n.id === 'rdp' && rdpOpen > 0 && <span className="rail-badge">{rdpOpen}</span>}
          </button>
        ))}
        <div className="rail-spacer" />
        <button className="rail-btn" title="Settings (Ctrl+,)" onClick={props.onSettings}>
          <Icon name="gear" size={18} />
        </button>
      </nav>
      <div className="side-panel">
        <div className="side-title">{NAV.find((n) => n.id === panel)?.label}</div>
        {panel === 'hosts' && <HostsPanel ctx={ctx} />}
        {panel === 'rdp' && <RdpPanel ctx={props.rdp} />}
        {panel === 'snippets' && <SnippetsPanel ctx={ctx} />}
        {panel === 'history' && <HistoryPanel ctx={ctx} />}
        {panel === 'keychain' && <KeychainPanel ctx={ctx} />}
        {panel === 'tunnels' && <TunnelsPanel ctx={ctx} />}
        {panel === 'workspaces' && <WorkspacesPanel ctx={ctx} />}
        {panel === 'logs' && <LogsPanel ctx={ctx} />}
        {panel === 'knownhosts' && <KnownHostsPanel ctx={ctx} />}
      </div>
    </aside>
  );
}

export function SearchBox(props: { value: string; onChange(v: string): void; placeholder: string; children?: React.ReactNode }) {
  return (
    <div className="side-tools">
      <label className="search">
        <Icon name="search" size={14} />
        <input placeholder={props.placeholder} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      </label>
      {props.children}
    </div>
  );
}

// ---------------- Hosts ----------------

const PROTO_ICON: Record<string, string> = { ssh: 'server', telnet: 'terminal', serial: 'bolt' };

function HostsPanel({ ctx }: { ctx: SidebarCtx }) {
  const [query, setQuery] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const [addMenu, setAddMenu] = useState(false);
  const allTags = [...new Set(ctx.hosts.flatMap((h) => h.tags ?? []))].sort();
  const filtering = !!query || tags.length > 0;
  const visible = ctx.hosts.filter(
    (h) =>
      matches(query, h.name, h.address, h.user, h.group, h.env, (h.tags ?? []).join(' '), h.protocol) &&
      tags.every((t) => (h.tags ?? []).includes(t)),
  );
  const tree = buildGroupTree(visible, filtering ? [] : ctx.groups.map((g) => g.path));
  const toggle = (p: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const hostMenu = (h: Host): (MenuItem | 'sep')[] => [
    { label: 'Connect', icon: <Icon name="play" size={12} />, onClick: () => ctx.connect(h) },
    { label: 'Connect in split', icon: <Icon name="splitRight" size={13} />, onClick: () => ctx.connect(h, true) },
    ...((h.protocol || 'ssh') === 'ssh' ? [{ label: 'Open SFTP', icon: <Icon name="folder" size={13} />, onClick: () => ctx.openSftp(h) }] : []),
    'sep',
    { label: 'Edit', icon: <Icon name="edit" size={13} />, onClick: () => ctx.editHost(h) },
    { label: 'Duplicate', icon: <Icon name="copy" size={13} />, onClick: () => ctx.duplicateHost(h) },
    { label: 'Delete', icon: <Icon name="trash" size={13} />, onClick: () => ctx.deleteHost(h) },
  ];
  const groupMenu = (path: string): MenuEntry[] => [
    { label: 'Connect to all hosts', icon: <Icon name="play" size={12} />, onClick: () => ctx.connectGroup(path) },
    { label: 'New host in group', icon: <Icon name="plus" size={13} />, onClick: () => ctx.editHost(null, path) },
    { label: 'New subgroup', icon: <Icon name="folder" size={13} />, onClick: () => ctx.editGroup(path + '/') },
    'sep',
    { swatches: true, label: 'Color — shown on its tabs', value: ctx.colors[sshGroupKey(path)] ?? null, onPick: (c) => ctx.setColor(sshGroupKey(path), c) },
    'sep',
    { label: 'Group settings…', icon: <Icon name="gear" size={13} />, onClick: () => ctx.editGroup(path) },
  ];

  const renderHost = (h: Host, depth: number) => (
    <div
      key={h.id}
      className="row host-row"
      style={{ paddingLeft: 8 + depth * 12 }}
      tabIndex={0}
      title="Double-click or Enter to connect · right-click for more"
      onDoubleClick={() => ctx.connect(h)}
      onKeyDown={(e) => e.key === 'Enter' && ctx.connect(h)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, items: hostMenu(h) });
      }}
    >
      <span className={`host-ico env-${h.env || 'none'}`}>
        <Icon name={PROTO_ICON[h.protocol || 'ssh'] ?? 'server'} size={14} />
      </span>
      <div className="row-main">
        <div className="row-title">
          {h.name}
          {h.env === 'prod' && <span className="mini-badge prod">PROD</span>}
          {h.protocol && h.protocol !== 'ssh' && <span className="mini-badge proto">{h.protocol.toUpperCase()}</span>}
        </div>
        <div className="row-sub">{h.protocol === 'serial' ? `${h.serial?.port} @ ${h.serial?.baud}` : hostLabel(h)}</div>
        {(h.tags ?? []).length > 0 && (
          <div className="row-tags">
            {(h.tags ?? []).map((t) => (
              <span key={t} className="tag sm">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button className="icon-btn sm" title="Connect" onClick={() => ctx.connect(h)}>
          <Icon name="play" size={12} />
        </button>
        {(h.protocol || 'ssh') === 'ssh' && (
          <button className="icon-btn sm" title="SFTP" onClick={() => ctx.openSftp(h)}>
            <Icon name="folder" size={13} />
          </button>
        )}
        <button className="icon-btn sm" title="More" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, items: hostMenu(h) })}>
          <Icon name="dots" size={14} />
        </button>
      </div>
    </div>
  );

  const renderGroup = (node: GroupNode, depth: number): React.ReactNode => {
    const open = filtering || !collapsed.has(node.path);
    const hasSettings = ctx.groups.some((g) => g.path === node.path);
    return (
      <section key={node.path}>
        <div
          className={`group-head ${open ? 'open' : ''}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => toggle(node.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, items: groupMenu(node.path) });
          }}
        >
          <span className="chev">
            <Icon name="chevron" size={12} />
          </span>
          {colorCss(ctx.colors[sshGroupKey(node.path)]) && (
            <span className="group-dot" style={{ '--grp': colorCss(ctx.colors[sshGroupKey(node.path)]) } as React.CSSProperties} />
          )}
          <span className="group-name">{node.name}</span>
          {hasSettings && (
            <span className="group-flag" title="Has group settings">
              <Icon name="gear" size={10} />
            </span>
          )}
          <span className="group-count">{node.total}</span>
          <span className="group-actions" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn sm" title="Connect to all" onClick={() => ctx.connectGroup(node.path)}>
              <Icon name="play" size={11} />
            </button>
            <button className="icon-btn sm" title="Group settings" onClick={() => ctx.editGroup(node.path)}>
              <Icon name="gear" size={12} />
            </button>
          </span>
        </div>
        {open && (
          <>
            {node.children.map((c) => renderGroup(c, depth + 1))}
            {node.hosts.map((h) => renderHost(h, depth + 1))}
          </>
        )}
      </section>
    );
  };

  return (
    <>
      <SearchBox value={query} onChange={setQuery} placeholder="Filter hosts, groups, tags">
        <div className="menu-anchor">
          <button className="icon-btn boxed accent" title="Add" onClick={() => setAddMenu((v) => !v)}>
            <Icon name="plus" size={15} />
          </button>
          {addMenu && (
            <Menu
              align="right"
              onClose={() => setAddMenu(false)}
              items={[
                { label: 'New host', icon: <Icon name="server" size={13} />, onClick: () => ctx.editHost(null) },
                { label: 'New group', icon: <Icon name="folder" size={13} />, onClick: () => ctx.editGroup(null) },
                'sep',
                { label: 'Import ~/.ssh/config', icon: <Icon name="import" size={13} />, onClick: ctx.importSSHConfig },
                { label: 'Import PuTTY sessions', icon: <Icon name="import" size={13} />, onClick: ctx.importPuTTY },
              ]}
            />
          )}
        </div>
      </SearchBox>
      {allTags.length > 0 && (
        <div className="tag-filter">
          {allTags.map((t) => (
            <button key={t} className={`tag ${tags.includes(t) ? 'on' : ''}`} onClick={() => setTags((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]))}>
              {t}
            </button>
          ))}
        </div>
      )}
      <div className="side-list">
        {ctx.hosts.length === 0 && (
          <div className="side-empty">
            <p>No hosts yet.</p>
            <button className="btn primary sm" onClick={() => ctx.editHost(null)}>
              Add a host
            </button>
            <button className="btn sm" onClick={ctx.importSSHConfig}>
              Import ~/.ssh/config
            </button>
            <button className="btn sm" onClick={ctx.importPuTTY}>
              Import PuTTY sessions
            </button>
          </div>
        )}
        {filtering && visible.length === 0 && <div className="side-empty">No matching hosts.</div>}
        {tree.children.map((c) => renderGroup(c, 0))}
        {tree.hosts.map((h) => renderHost(h, 0))}
      </div>
      {menu && <Menu items={menu.items} at={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />}
    </>
  );
}

// ---------------- Snippets ----------------

function SnippetsPanel({ ctx }: { ctx: SidebarCtx }) {
  const [query, setQuery] = useState('');
  // Groups start closed; click one to open it (searching shows every match).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = ctx.snippets.find((s) => s.id === selectedId);
  const groups = groupBy(
    ctx.snippets.filter((s) => matches(query, s.name, s.command, s.group, s.description)),
    (s) => s.group,
  );
  return (
    <>
      <SearchBox value={query} onChange={setQuery} placeholder="Filter snippets">
        <button className="icon-btn boxed accent" title="New snippet" onClick={() => ctx.editSnippet(null)}>
          <Icon name="plus" size={15} />
        </button>
      </SearchBox>
      <div className="side-list">
        {!ctx.hasSession && ctx.snippets.length > 0 && <div className="side-note">Open a terminal to run snippets, or use "Run on hosts".</div>}
        {groups.map(([group, list]) => {
          const key = group || 'General';
          const open = expanded.has(key) || !!query;
          return (
            <section key={key}>
              <div
                className={`group-head ${open ? 'open' : ''}`}
                onClick={() =>
                  setExpanded((s) => {
                    const n = new Set(s);
                    if (n.has(key)) n.delete(key);
                    else n.add(key);
                    return n;
                  })
                }
              >
                <span className="chev">
                  <Icon name="chevron" size={12} />
                </span>
                <span className="group-name">{key}</span>
                <span className="group-count">{list.length}</span>
              </div>
              {open &&
                list.map((s) => (
                  <div
                    key={s.id}
                    className={`row ${s.id === selectedId ? 'selected' : ''}`}
                    tabIndex={0}
                    title="Click for details, double-click to run"
                    onClick={() => setSelectedId(s.id)}
                    onFocus={() => setSelectedId(s.id)}
                    onDoubleClick={() => ctx.runSnippet(s, true)}
                    onKeyDown={(e) => e.key === 'Enter' && ctx.runSnippet(s, true)}
                  >
                    <div className="row-main">
                      <div className="row-title">{s.name}</div>
                      <div className={`row-sub ${s.description ? 'desc' : ''}`}>{s.description || s.command}</div>
                    </div>
                    <div className="row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn sm" title="Run (sends Enter)" disabled={!ctx.hasSession} onClick={() => ctx.runSnippet(s, true)}>
                        <Icon name="play" size={12} />
                      </button>
                      <button className="icon-btn sm" title="Run on several hosts…" onClick={() => ctx.runSnippetOnHosts(s)}>
                        <Icon name="broadcast" size={13} />
                      </button>
                      <button className="icon-btn sm" title="Edit" onClick={() => ctx.editSnippet(s)}>
                        <Icon name="edit" size={13} />
                      </button>
                    </div>
                  </div>
                ))}
            </section>
          );
        })}
      </div>
      {selected && (
        <SnippetInfo
          snippet={selected}
          canRun={ctx.hasSession}
          onRun={(execute) => ctx.runSnippet(selected, execute)}
          onRunOnHosts={() => ctx.runSnippetOnHosts(selected)}
          onEdit={() => ctx.editSnippet(selected)}
          onDelete={() => ctx.deleteSnippet(selected)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </>
  );
}

// ---------------- History ----------------

function HistoryPanel({ ctx }: { ctx: SidebarCtx }) {
  const [query, setQuery] = useState('');
  useSyncExternalStore(history.subscribe, history.getVersion);
  const items = history.recent(query);
  return (
    <>
      <SearchBox value={query} onChange={setQuery} placeholder="Search commands">
        <button className="icon-btn boxed danger" title="Clear all history" onClick={ctx.clearHistory}>
          <Icon name="trash" size={15} />
        </button>
      </SearchBox>
      <div className="side-list">
        {items.length === 0 && (
          <div className="side-empty">
            <p>{query ? 'No matching commands.' : 'Commands you run in any terminal show up here.'}</p>
            <p className="hint">Press ↑ at a prompt to pick from history, → to accept the gray suggestion.</p>
          </div>
        )}
        {items.map((it) => (
          <div
            key={it.command}
            className="row history-row"
            tabIndex={0}
            title={`${it.command}\n\nDouble-click to run in the active terminal`}
            onDoubleClick={() => ctx.runHistory(it.command, true)}
          >
            <div className="row-main">
              <div className="row-title mono">{it.command}</div>
              <div className="row-sub desc">
                {ctx.historyHostLabel(it.hostKeys[it.hostKeys.length - 1])}
                {it.hostKeys.length > 1 ? ` +${it.hostKeys.length - 1}` : ''} · {timeAgo(it.lastUsed)}
                {it.count > 1 ? ` · ×${it.count}` : ''}
              </div>
            </div>
            <div className="row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
              <button className="icon-btn sm" title="Run" disabled={!ctx.hasSession} onClick={() => ctx.runHistory(it.command, true)}>
                <Icon name="play" size={12} />
              </button>
              <button className="icon-btn sm" title="Insert without running" disabled={!ctx.hasSession} onClick={() => ctx.runHistory(it.command, false)}>
                <Icon name="insert" size={13} />
              </button>
              <button className="icon-btn sm danger" title="Forget" onClick={() => history.remove(it.command)}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
