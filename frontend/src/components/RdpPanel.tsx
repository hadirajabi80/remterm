import { useState } from 'react';
import { clipboard } from '../api';
import { lastUsedMs, machineDetail } from '../rdp';
import { NO_CREDENTIAL, type Machine, type RdpData, type RdpStatus, type TabStatus } from '../types';
import { matches } from '../util';
import { Icon } from './Icon';
import { colorCss, rdpGroupKey } from '../colors';
import { Menu, type MenuEntry, type MenuItem } from './Menu';
import type { RdpSettingsTab } from './RdpDialogs';
import { UnlockForm } from './RdpDialogs';
import { SearchBox } from './Sidebar';

/** What the Remote Desktop panel shows and can do (provided by App). */
export interface RdpCtx {
  available: boolean;
  status: RdpStatus | null;
  data: RdpData | null;
  error: string;
  /** Best status of the open sessions per machine id (dot in the list). */
  openStatus: Record<string, TabStatus>;
  connect(m: Machine, split?: boolean): void;
  switchTo(m: Machine): void;
  connectAll(list: Machine[]): void;
  openSelector(): void;
  edit(m: Machine | null, group?: string): void;
  save(m: Machine): void;
  remove(list: Machine[], what: string): void;
  renameGroup(name: string): void;
  logins(): void;
  settings(tab?: RdpSettingsTab): void;
  importList(): void;
  lock(): void;
  refresh(): void;
  notify(text: string, kind?: 'info' | 'error'): void;
  /** Group colors ('rdp:<group>' -> color id). */
  colors: Record<string, string>;
  setColor(key: string, color: string | null): void;
}

const UNGROUPED = 'Ungrouped';

export function RdpPanel({ ctx }: { ctx: RdpCtx }) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const [addMenu, setAddMenu] = useState(false);

  if (!ctx.available) {
    return (
      <div className="side-list">
        <div className="side-empty">
          <p>Remote Desktop is not installed with this copy of Remterm ({'RemtermRdp.exe'} is missing).</p>
          <p className="hint">Reinstall Remterm with the setup program to get it back.</p>
        </div>
      </div>
    );
  }
  if (ctx.status?.needsPassword) {
    return (
      <div className="side-list">
        <div className="side-empty">
          <Icon name="lock" size={22} />
          <p>Your Remote Desktop vault is protected by a master password.</p>
          <UnlockForm compact onUnlocked={ctx.refresh} />
        </div>
      </div>
    );
  }
  const data = ctx.data;
  if (!data) {
    return (
      <div className="side-list">
        <div className="side-empty">
          {ctx.error ? (
            <>
              <p>{ctx.error}</p>
              <button className="btn sm" onClick={ctx.refresh}>
                Try again
              </button>
            </>
          ) : (
            <p className="hint">Starting Remote Desktop…</p>
          )}
        </div>
      </div>
    );
  }

  const machines = data.machines;
  const toggle = (k: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const byName = (a: Machine, b: Machine) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

  const sections: { key: string; title: string; items: Machine[]; group?: string; special?: boolean }[] = [];
  if (query) {
    sections.push({ key: 'results', title: 'Results', items: machines.filter((m) => matches(query, m.name, m.ip, m.group, m.target, m.notes)).sort(byName), special: true });
  } else {
    const favs = machines.filter((m) => m.favorite).sort(byName);
    if (favs.length) sections.push({ key: '★', title: '★ Favorites', items: favs, special: true });
    const recent = machines.filter((m) => m.lastUsed).sort((a, b) => lastUsedMs(b) - lastUsedMs(a)).slice(0, 6);
    if (recent.length) sections.push({ key: '⏱', title: 'Recent', items: recent, special: true });
    const groups = new Map<string, Machine[]>();
    for (const m of machines) {
      const g = m.group.trim() || UNGROUPED;
      const key = [...groups.keys()].find((k) => k.toLowerCase() === g.toLowerCase()) ?? g;
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    [...groups.entries()]
      .sort(([a], [b]) => (a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b)))
      .forEach(([g, items]) => sections.push({ key: 'g:' + g, title: g, items: items.sort(byName), group: g }));
  }

  const credItem = (m: Machine, label: string, id: string | null): MenuItem => ({
    label: `Login: ${label}`,
    icon: (m.credentialId ?? null) === id ? <Icon name="check" size={13} /> : <span />,
    onClick: () => ctx.save({ ...m, credentialId: id }),
  });

  const machineMenu = (m: Machine): (MenuItem | 'sep')[] => [
    { label: 'Connect', icon: <Icon name="play" size={12} />, onClick: () => ctx.connect(m) },
    { label: 'Connect in split', icon: <Icon name="splitRight" size={13} />, onClick: () => ctx.connect(m, true) },
    ...(ctx.openStatus[m.id] ? [{ label: 'Switch to open session', icon: <Icon name="monitor" size={13} />, onClick: () => ctx.switchTo(m) }] : []),
    'sep',
    { label: 'Edit…', icon: <Icon name="edit" size={13} />, hint: 'F2', onClick: () => ctx.edit(m) },
    { label: m.favorite ? 'Remove from favorites' : 'Add to favorites', icon: <Icon name="star" size={13} />, onClick: () => ctx.save({ ...m, favorite: !m.favorite }) },
    {
      label: 'Keep connected',
      hint: m.keepAlive ? 'on' : 'off',
      icon: m.keepAlive ? <Icon name="check" size={13} /> : <Icon name="pulse" size={13} />,
      onClick: () => ctx.save({ ...m, keepAlive: !m.keepAlive }),
    },
    { label: 'Copy IP', icon: <Icon name="copy" size={13} />, disabled: !m.ip, onClick: () => void clipboard.write(m.ip) },
    ...(m.mode === 'bastion'
      ? [{ label: 'Copy WALLIX target', icon: <Icon name="copy" size={13} />, disabled: !m.target, onClick: () => void clipboard.write(m.target) }]
      : []),
    'sep',
    credItem(m, '★ default', null),
    ...data.credentials.map((c) => credItem(m, c.name, c.id)),
    credItem(m, 'none (type myself)', NO_CREDENTIAL),
    'sep',
    { label: 'Delete', icon: <Icon name="trash" size={13} />, hint: 'Del', onClick: () => ctx.remove([m], `"${m.name}"`) },
  ];

  const groupMenu = (g: string, items: Machine[]): MenuEntry[] => [
    { label: `Connect all (${items.length})`, icon: <Icon name="play" size={12} />, onClick: () => ctx.connectAll(items) },
    { label: 'New machine in group', icon: <Icon name="plus" size={13} />, onClick: () => ctx.edit(null, g === UNGROUPED ? '' : g) },
    { label: 'Rename group…', icon: <Icon name="edit" size={13} />, onClick: () => ctx.renameGroup(g) },
    'sep',
    { swatches: true, label: 'Color — shown on its tabs', value: ctx.colors[rdpGroupKey(g)] ?? null, onPick: (c) => ctx.setColor(rdpGroupKey(g), c) },
    'sep',
    { label: `Delete all ${items.length} machines…`, icon: <Icon name="trash" size={13} />, onClick: () => ctx.remove(items, `all ${items.length} machines in "${g}"`) },
  ];

  const bastionMissing = !data.bastion.host.trim();
  const showSetup = machines.length === 0 || (bastionMissing && machines.some((m) => m.mode === 'bastion'));

  const renderMachine = (m: Machine, sectionKey: string) => {
    const st = ctx.openStatus[m.id];
    return (
      <div
        key={sectionKey + m.id}
        className="row host-row"
        tabIndex={0}
        title={`${m.name}\n${machineDetail(m)}${m.notes ? '\n\n' + m.notes : ''}\n\nDouble-click or Enter to connect · right-click for more`}
        onDoubleClick={() => ctx.connect(m)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') ctx.connect(m);
          else if (e.key === 'F2') ctx.edit(m);
          else if (e.key === 'Delete') ctx.remove([m], `"${m.name}"`);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, items: machineMenu(m) });
        }}
      >
        <span className={`host-ico rdp ${m.mode}`}>
          <Icon name="monitor" size={14} />
          {st && <span className={`ico-dot sdot ${st}`} />}
        </span>
        <div className="row-main">
          <div className="row-title">
            {m.name}
            {m.mode === 'direct' && <span className="mini-badge proto">DIRECT</span>}
            {m.favorite && <span className="fav-star">★</span>}
            {m.keepAlive && (
              <span className="keep-badge" title="Keep connected is on">
                <Icon name="pulse" size={11} />
              </span>
            )}
          </div>
          <div className="row-sub">{m.mode === 'direct' ? m.ip : m.ip || m.target || 'WALLIX list'}</div>
        </div>
        <div className="row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <button className="icon-btn sm" title="Connect" onClick={() => ctx.connect(m)}>
            <Icon name="play" size={12} />
          </button>
          <button className="icon-btn sm" title="Edit" onClick={() => ctx.edit(m)}>
            <Icon name="edit" size={13} />
          </button>
          <button className="icon-btn sm" title="More" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, items: machineMenu(m) })}>
            <Icon name="dots" size={14} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      <SearchBox value={query} onChange={setQuery} placeholder={`Filter ${machines.length} machines`}>
        <div className="menu-anchor">
          <button className="icon-btn boxed accent" title="Add" onClick={() => setAddMenu((v) => !v)}>
            <Icon name="plus" size={15} />
          </button>
          {addMenu && (
            <Menu
              align="right"
              onClose={() => setAddMenu(false)}
              items={[
                { label: 'New machine', icon: <Icon name="monitor" size={13} />, onClick: () => ctx.edit(null) },
                { label: 'Import WALLIX list…', icon: <Icon name="import" size={13} />, onClick: ctx.importList },
                'sep',
                { label: 'Open the WALLIX list', icon: <Icon name="layout" size={13} />, onClick: ctx.openSelector },
              ]}
            />
          )}
        </div>
      </SearchBox>
      <div className="rdp-tools">
        <button className="btn sm" title="Logins typed with Ctrl+Alt+K" onClick={ctx.logins}>
          <Icon name="key" size={12} /> Logins
          <span className="count">{data.credentials.length}</span>
        </button>
        <button className="btn sm" title="Bastion, auto-fill, display, security" onClick={() => ctx.settings()}>
          <Icon name="gear" size={12} /> Settings
        </button>
        {data.hasMaster && (
          <button className="icon-btn sm" title="Lock (Ctrl+Alt+L)" onClick={ctx.lock}>
            <Icon name="lock" size={13} />
          </button>
        )}
      </div>
      <div className="side-list">
        {showSetup && !query && (
          <div className="setup-card">
            <div className="setup-title">Set up Remote Desktop</div>
            <button className={`setup-step ${bastionMissing ? '' : 'done'}`} onClick={() => ctx.settings('bastion')}>
              <span className="setup-num">{bastionMissing ? '1' : <Icon name="check" size={11} />}</span>
              <span>
                WALLIX bastion &amp; your login <span className="hint">(skip for direct RDP)</span>
              </span>
            </button>
            <button className={`setup-step ${data.credentials.length ? 'done' : ''}`} onClick={ctx.logins}>
              <span className="setup-num">{data.credentials.length ? <Icon name="check" size={11} /> : '2'}</span>
              <span>
                Machine logins <span className="hint">(optional — asked when connecting)</span>
              </span>
            </button>
            <button className={`setup-step ${machines.length ? 'done' : ''}`} onClick={ctx.importList}>
              <span className="setup-num">{machines.length ? <Icon name="check" size={11} /> : '3'}</span>
              <span>Import machines or add one</span>
            </button>
          </div>
        )}
        {query && sections[0]?.items.length === 0 && <div className="side-empty">No matching machines.</div>}
        {sections.map((sec) => {
          const open = !!query || !collapsed.has(sec.key);
          return (
            <section key={sec.key}>
              <div
                className={`group-head ${open ? 'open' : ''} ${sec.key === '★' ? 'fav' : ''}`}
                onClick={() => toggle(sec.key)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (sec.group) setMenu({ x: e.clientX, y: e.clientY, items: groupMenu(sec.group, sec.items) });
                }}
              >
                <span className="chev">
                  <Icon name="chevron" size={12} />
                </span>
                {sec.group && colorCss(ctx.colors[rdpGroupKey(sec.group)]) && (
                  <span className="group-dot" style={{ '--grp': colorCss(ctx.colors[rdpGroupKey(sec.group)]) } as React.CSSProperties} />
                )}
                <span className="group-name">{sec.title}</span>
                <span className="group-count">{sec.items.length}</span>
                {sec.group && (
                  <span className="group-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn sm" title="Connect all" onClick={() => ctx.connectAll(sec.items)}>
                      <Icon name="play" size={11} />
                    </button>
                    <button className="icon-btn sm" title="More" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, items: groupMenu(sec.group!, sec.items) })}>
                      <Icon name="dots" size={13} />
                    </button>
                  </span>
                )}
              </div>
              {open && sec.items.map((m) => renderMachine(m, sec.key))}
            </section>
          );
        })}
      </div>
      {menu && <Menu items={menu.items} at={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />}
    </>
  );
}
