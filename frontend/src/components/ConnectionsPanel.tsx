import { useState } from 'react';
import { lastUsedMs, machineDetail, machineSub } from '../rdp';
import type { Host, Machine } from '../types';
import { hostLabel, matches } from '../util';
import { Icon } from './Icon';
import { colorCss, rdpGroupKey, sshGroupKey } from '../colors';
import { Menu, type MenuEntry } from './Menu';
import { machineMenuItems, type RdpCtx } from './RdpPanel';
import { UnlockForm } from './RdpDialogs';
import { hostMenuItems, PROTO_ICON, SearchBox, type SidebarCtx } from './Sidebar';

// One list for every saved connection, like Remote Desktop Manager: SSH hosts
// and Remote Desktop machines side by side. Each still lives in its own store
// (SSH in Remterm's, RDP in the encrypted vault); folders with the same path
// (SSH "Prod/Web", RDP "Prod/Web") are shown as one folder.

type Item = { kind: 'ssh'; host: Host } | { kind: 'rdp'; machine: Machine };
type Kind = 'all' | 'ssh' | 'rdp';

interface Folder {
  key: string; // lower-cased path
  path: string;
  name: string;
  children: Folder[];
  items: Item[];
  total: number;
}

const cleanPath = (g: string) =>
  g
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('/');
const itemName = (it: Item) => (it.kind === 'ssh' ? it.host.name : it.machine.name);
const itemGroup = (it: Item) => cleanPath(it.kind === 'ssh' ? it.host.group : it.machine.group);
const itemKey = (it: Item) => (it.kind === 'ssh' ? 'h:' + it.host.id : 'm:' + it.machine.id);
const itemUsed = (it: Item) => (it.kind === 'ssh' ? it.host.lastUsed || 0 : lastUsedMs(it.machine));
const byName = (a: Item, b: Item) => itemName(a).localeCompare(itemName(b), undefined, { sensitivity: 'base' });

function buildTree(items: Item[], extraPaths: string[]): Folder {
  const root: Folder = { key: '', path: '', name: '', children: [], items: [], total: 0 };
  const nodeFor = (path: string): Folder => {
    let node = root;
    let acc = '';
    for (const part of path.split('/').filter(Boolean)) {
      acc = acc ? `${acc}/${part}` : part;
      const key = acc.toLowerCase();
      let child = node.children.find((c) => c.key === key);
      if (!child) {
        child = { key, path: acc, name: part, children: [], items: [], total: 0 };
        node.children.push(child);
      }
      node = child;
    }
    return node;
  };
  extraPaths.forEach((p) => nodeFor(cleanPath(p)));
  items.forEach((it) => nodeFor(itemGroup(it)).items.push(it));
  const finish = (n: Folder): number => {
    n.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    n.items.sort(byName);
    n.total = n.items.length + n.children.reduce((s, c) => s + finish(c), 0);
    return n.total;
  };
  finish(root);
  return root;
}

const allItems = (f: Folder): Item[] => [...f.items, ...f.children.flatMap(allItems)];

export function ConnectionsPanel({ ctx, rdp }: { ctx: SidebarCtx; rdp: RdpCtx }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const [addMenu, setAddMenu] = useState(false);

  const data = rdp.data;
  const machines = data?.machines ?? [];
  const sshItems: Item[] = ctx.hosts.map((host) => ({ kind: 'ssh', host }));
  const rdpItems: Item[] = machines.map((machine) => ({ kind: 'rdp', machine }));
  const shown = [...(kind !== 'rdp' ? sshItems : []), ...(kind !== 'ssh' ? rdpItems : [])];
  const visible = shown.filter((it) =>
    it.kind === 'ssh'
      ? matches(query, it.host.name, it.host.address, it.host.user, it.host.group, it.host.env, (it.host.tags ?? []).join(' '), it.host.protocol, 'ssh')
      : matches(query, it.machine.name, it.machine.ip, it.machine.group, it.machine.target, it.machine.notes, it.machine.username ?? '', 'rdp'),
  );
  const tree = buildTree(visible, query || kind === 'rdp' ? [] : ctx.groups.map((g) => g.path));
  const favorites = query ? [] : visible.filter((it) => (it.kind === 'ssh' ? it.host.favorite : it.machine.favorite)).sort(byName);
  const recent = query
    ? []
    : visible
        .filter((it) => itemUsed(it) > 0)
        .sort((a, b) => itemUsed(b) - itemUsed(a))
        .slice(0, 5);

  const toggle = (k: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const open = (it: Item, split?: boolean) => (it.kind === 'ssh' ? ctx.connect(it.host, split) : rdp.connect(it.machine, split));
  const itemMenu = (it: Item): MenuEntry[] => (it.kind === 'ssh' ? hostMenuItems(ctx, it.host) : data ? machineMenuItems(rdp, data, it.machine) : []);
  const showMenu = (e: React.MouseEvent, items: MenuEntry[]) => {
    e.preventDefault();
    if (items.length) setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const folderColor = (path: string) => colorCss(ctx.colors[sshGroupKey(path)]) ?? colorCss(rdp.colors[rdpGroupKey(path)]);
  const connectFolder = (f: Folder) => {
    const items = allItems(f);
    if (items.some((it) => it.kind === 'ssh')) ctx.connectGroup(f.path);
    const ms = items.flatMap((it) => (it.kind === 'rdp' ? [it.machine] : []));
    if (ms.length) rdp.connectAll(ms);
  };
  const folderMenu = (f: Folder): MenuEntry[] => {
    const hasSettings = ctx.groups.some((g) => g.path === f.path);
    return [
      { label: `Connect all (${f.total})`, icon: <Icon name="play" size={12} />, onClick: () => connectFolder(f) },
      'sep',
      { label: 'New SSH host here', icon: <Icon name="server" size={13} />, onClick: () => ctx.editHost(null, f.path) },
      ...(data ? [{ label: 'New Remote Desktop here', icon: <Icon name="monitor" size={13} />, onClick: () => rdp.edit(null, f.path) }] : []),
      { label: 'New subfolder', icon: <Icon name="folder" size={13} />, onClick: () => ctx.editGroup(f.path + '/') },
      'sep',
      {
        swatches: true,
        label: 'Color — shown on its tabs',
        value: ctx.colors[sshGroupKey(f.path)] ?? rdp.colors[rdpGroupKey(f.path)] ?? null,
        onPick: (c) => {
          ctx.setColor(sshGroupKey(f.path), c);
          rdp.setColor(rdpGroupKey(f.path), c);
        },
      },
      'sep',
      { label: hasSettings ? 'SSH folder settings…' : 'SSH settings for this folder…', icon: <Icon name="gear" size={13} />, onClick: () => ctx.editGroup(f.path) },
    ];
  };

  const renderItem = (it: Item, depth: number, section: string) => {
    const pad = { paddingLeft: 8 + depth * 12 };
    if (it.kind === 'ssh') {
      const h = it.host;
      const proto = h.protocol || 'ssh';
      return (
        <div
          key={section + itemKey(it)}
          className="row host-row"
          style={pad}
          tabIndex={0}
          title={`${h.name}\n${hostLabel(h)}\n\nDouble-click or Enter to connect · right-click for more`}
          onDoubleClick={() => open(it)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') open(it);
            else if (e.key === 'F2') ctx.editHost(h);
          }}
          onContextMenu={(e) => showMenu(e, itemMenu(it))}
        >
          <span className={`host-ico env-${h.env || 'none'}`}>
            <Icon name={PROTO_ICON[proto] ?? 'server'} size={14} />
          </span>
          <div className="row-main">
            <div className="row-title">
              {h.name}
              <span className="mini-badge kind ssh">{proto.toUpperCase()}</span>
              {h.env === 'prod' && <span className="mini-badge prod">PROD</span>}
              {h.favorite && <span className="fav-star">★</span>}
            </div>
            <div className="row-sub">{proto === 'serial' ? `${h.serial?.port} @ ${h.serial?.baud}` : hostLabel(h)}</div>
          </div>
          <div className="row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            <button className="icon-btn sm" title="Connect" onClick={() => open(it)}>
              <Icon name="play" size={12} />
            </button>
            {proto === 'ssh' && (
              <button className="icon-btn sm" title="SFTP" onClick={() => ctx.openSftp(h)}>
                <Icon name="folder" size={13} />
              </button>
            )}
            <button className="icon-btn sm" title="More" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, items: itemMenu(it) })}>
              <Icon name="dots" size={14} />
            </button>
          </div>
        </div>
      );
    }
    const m = it.machine;
    const st = rdp.openStatus[m.id];
    return (
      <div
        key={section + itemKey(it)}
        className="row host-row"
        style={pad}
        tabIndex={0}
        title={`${m.name}\n${machineDetail(m)}${m.notes ? '\n\n' + m.notes : ''}\n\nDouble-click or Enter to connect · right-click for more`}
        onDoubleClick={() => open(it)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') open(it);
          else if (e.key === 'F2') rdp.edit(m);
          else if (e.key === 'Delete') rdp.remove([m], `"${m.name}"`);
        }}
        onContextMenu={(e) => showMenu(e, itemMenu(it))}
      >
        <span className={`host-ico rdp ${m.mode}`}>
          <Icon name="monitor" size={14} />
          {st && <span className={`ico-dot sdot ${st}`} />}
        </span>
        <div className="row-main">
          <div className="row-title">
            {m.name}
            <span className="mini-badge kind rdp">{m.mode === 'bastion' ? 'RDP · WALLIX' : 'RDP'}</span>
            {m.favorite && <span className="fav-star">★</span>}
            {m.keepAlive && (
              <span className="keep-badge" title="Keep connected is on">
                <Icon name="pulse" size={11} />
              </span>
            )}
          </div>
          <div className="row-sub">{machineSub(m)}</div>
        </div>
        <div className="row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <button className="icon-btn sm" title="Connect" onClick={() => open(it)}>
            <Icon name="play" size={12} />
          </button>
          <button className="icon-btn sm" title="Edit" onClick={() => rdp.edit(m)}>
            <Icon name="edit" size={13} />
          </button>
          <button className="icon-btn sm" title="More" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, items: itemMenu(it) })}>
            <Icon name="dots" size={14} />
          </button>
        </div>
      </div>
    );
  };

  const renderFolder = (f: Folder, depth: number): React.ReactNode => {
    const isOpen = !!query || !collapsed.has('f:' + f.key);
    const color = folderColor(f.path);
    return (
      <section key={f.key}>
        <div
          className={`group-head ${isOpen ? 'open' : ''}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => toggle('f:' + f.key)}
          onContextMenu={(e) => showMenu(e, folderMenu(f))}
        >
          <span className="chev">
            <Icon name="chevron" size={12} />
          </span>
          {color && <span className="group-dot" style={{ '--grp': color } as React.CSSProperties} />}
          <span className="group-name">{f.name}</span>
          <span className="group-count">{f.total}</span>
          <span className="group-actions" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn sm" title="Connect all" onClick={() => connectFolder(f)}>
              <Icon name="play" size={11} />
            </button>
            <button className="icon-btn sm" title="More" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, items: folderMenu(f) })}>
              <Icon name="dots" size={13} />
            </button>
          </span>
        </div>
        {isOpen && (
          <>
            {f.children.map((c) => renderFolder(c, depth + 1))}
            {f.items.map((it) => renderItem(it, depth + 1, 'f:'))}
          </>
        )}
      </section>
    );
  };

  const special = (key: string, title: string, items: Item[]) => {
    if (!items.length) return null;
    const isOpen = !collapsed.has(key);
    return (
      <section key={key}>
        <div className={`group-head ${isOpen ? 'open' : ''} ${key === 'fav' ? 'fav' : ''}`} onClick={() => toggle(key)}>
          <span className="chev">
            <Icon name="chevron" size={12} />
          </span>
          <span className="group-name">{title}</span>
          <span className="group-count">{items.length}</span>
        </div>
        {isOpen && items.map((it) => renderItem(it, 0, key))}
      </section>
    );
  };

  const addItems: MenuEntry[] = [
    { label: 'New SSH host', icon: <Icon name="server" size={13} />, onClick: () => ctx.editHost(null) },
    ...(data ? [{ label: 'New Remote Desktop', icon: <Icon name="monitor" size={13} />, onClick: () => rdp.edit(null) }] : []),
    { label: 'New folder', icon: <Icon name="folder" size={13} />, onClick: () => ctx.editGroup(null) },
    'sep',
    { label: 'Import ~/.ssh/config', icon: <Icon name="import" size={13} />, onClick: ctx.importSSHConfig },
    { label: 'Import PuTTY sessions', icon: <Icon name="import" size={13} />, onClick: ctx.importPuTTY },
    ...(data ? [{ label: 'Import WALLIX list…', icon: <Icon name="import" size={13} />, onClick: rdp.importList }] : []),
    ...(data
      ? (['sep', { label: 'Saved Remote Desktop logins…', icon: <Icon name="key" size={13} />, onClick: rdp.logins }, { label: 'Remote Desktop settings…', icon: <Icon name="gear" size={13} />, onClick: () => rdp.settings() }] as MenuEntry[])
      : []),
  ];

  const empty = ctx.hosts.length === 0 && machines.length === 0;

  return (
    <>
      <SearchBox value={query} onChange={setQuery} placeholder="Search SSH and Remote Desktop">
        <div className="menu-anchor">
          <button className="icon-btn boxed accent" title="New connection" onClick={() => setAddMenu((v) => !v)}>
            <Icon name="plus" size={15} />
          </button>
          {addMenu && <Menu align="right" onClose={() => setAddMenu(false)} items={addItems} />}
        </div>
      </SearchBox>
      <div className="seg kind-seg" role="tablist">
        {(
          [
            ['all', 'All', ctx.hosts.length + machines.length],
            ['ssh', 'SSH', ctx.hosts.length],
            ['rdp', 'RDP', machines.length],
          ] as [Kind, string, number][]
        ).map(([k, label, n]) => (
          <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            {label} <span className="seg-count">{n}</span>
          </button>
        ))}
      </div>
      <div className="side-list">
        {rdp.available && rdp.status?.needsPassword && kind !== 'ssh' && (
          <div className="side-note">
            Remote Desktop connections are locked by your master password.
            <UnlockForm compact onUnlocked={rdp.refresh} />
          </div>
        )}
        {rdp.available && !data && rdp.error && kind !== 'ssh' && <div className="side-note">Remote Desktop: {rdp.error}</div>}
        {empty && !query && (
          <div className="side-empty">
            <p>Save SSH hosts and Remote Desktop machines here, together in folders.</p>
            <button className="btn primary sm" onClick={() => ctx.editHost(null)}>
              New SSH host
            </button>
            {data && (
              <button className="btn sm" onClick={() => rdp.edit(null)}>
                New Remote Desktop
              </button>
            )}
          </div>
        )}
        {query && visible.length === 0 && <div className="side-empty">No matching connections.</div>}
        {special('fav', '★ Favorites', favorites)}
        {special('recent', 'Recent', recent)}
        {tree.children.map((c) => renderFolder(c, 0))}
        {tree.items.map((it) => renderItem(it, 0, 'root'))}
      </div>
      {menu && <Menu items={menu.items} at={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />}
    </>
  );
}
