import { useState } from 'react';
import type { LocalShell, TabStatus } from '../types';
import { Icon } from './Icon';
import { Menu, type MenuItem } from './Menu';

/** What the tab strip shows for a tab (derived from its active pane). */
export interface TabView {
  key: string;
  title: string;
  subtitle: string;
  env: string;
  status: TabStatus;
  paneCount: number;
  broadcast: boolean;
  local: boolean;
  kind: string; // pane type of the active pane
  unread: boolean; // new output in a pane you are not looking at
}

export function TabBar(props: {
  tabs: TabView[];
  activeKey: string | null;
  shells: LocalShell[];
  hasActive: boolean;
  activePaneCount: number;
  zoomed: boolean;
  broadcast: boolean;
  onSelect(key: string): void;
  /** Pointer pressed on a tab: the app turns movement into a tab drag. */
  onTabPointerDown?(key: string, e: React.PointerEvent): void;
  draggingKey?: string | null;
  dropIndex?: number | null; // insertion mark while reordering
  onClose(key: string): void;
  onNewSsh(): void;
  onNewRdp?(): void;
  /** Tools for the active Remote Desktop pane (null when the active pane is not RDP). */
  rdp: { connected: boolean; mode: string; web?: boolean } | null;
  onRdp(action: 'fill' | 'fullscreen' | 'popout' | 'reconnect' | 'disconnect' | 'cad'): void;
  onNewLocal(shellId: string): void;
  onSplit(dir: 'row' | 'col'): void;
  onToggleZoom(): void;
  onToggleBroadcast(): void;
  onAppearance(): void;
  onToggleSidebar(): void;
}) {
  const [menu, setMenu] = useState(false);
  const menuItems: (MenuItem | 'sep')[] = [
    ...props.shells.map((s, i) => ({
      label: s.name,
      hint: i === 0 ? 'Ctrl+Shift+`' : undefined,
      icon: <Icon name="terminal" size={14} />,
      onClick: () => props.onNewLocal(s.id),
    })),
    ...(props.shells.length ? (['sep'] as const) : []),
    { label: 'SSH connection…', hint: 'Ctrl+Shift+T', icon: <Icon name="server" size={14} />, onClick: props.onNewSsh },
    ...(props.onNewRdp ? [{ label: 'Remote Desktop…', hint: 'Ctrl+Alt+P', icon: <Icon name="monitor" size={14} />, onClick: props.onNewRdp }] : []),
  ];

  return (
    <div className="tabbar">
      <button className="icon-btn" title="Toggle sidebar (Ctrl+Shift+B)" onClick={props.onToggleSidebar}>
        <Icon name="sidebar" />
      </button>
      <div className="tabs" role="tablist">
        {props.tabs.map((t, i) => (
          <div
            key={t.key}
            role="tab"
            aria-selected={t.key === props.activeKey}
            data-tab-key={t.key}
            className={`tab ${t.key === props.activeKey ? 'active' : ''} ${t.key === props.draggingKey ? 'dragging' : ''} ${props.dropIndex === i ? 'drop-before' : ''} ${props.dropIndex === i + 1 && i === props.tabs.length - 1 ? 'drop-after' : ''}`}
            title={`${t.subtitle}${i < 9 ? `  (Ctrl+${i + 1})` : ''}`}
            onClick={() => props.onSelect(t.key)}
            onPointerDown={(e) => {
              if (e.button === 0 && !(e.target as HTMLElement).closest('.tab-close')) props.onTabPointerDown?.(t.key, e);
            }}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                props.onClose(t.key);
              }
            }}
          >
            {t.env && <span className={`tab-env env-${t.env}`} />}
            <span className={`sdot ${t.status}`} />
            {t.local && <Icon name="terminal" size={12} />}
            {t.kind === 'sftp' && <Icon name="folder" size={12} />}
            {t.kind === 'log' && <Icon name="file" size={12} />}
            {t.kind === 'rdp' && <Icon name="monitor" size={12} />}
            <span className="tab-title">{t.title}</span>
            {t.paneCount > 1 && <span className="tab-count" title={`${t.paneCount} panes`}>{t.paneCount}</span>}
            {t.unread && <span className="tab-unread" title="New output" />}
            {t.broadcast && (
              <span className="tab-broadcast" title="Broadcast input is on">
                <Icon name="broadcast" size={12} />
              </span>
            )}
            <button
              className="tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                props.onClose(t.key);
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="menu-anchor">
        <button className={`icon-btn ${menu ? 'on' : ''}`} title="New tab" onClick={() => setMenu((v) => !v)}>
          <Icon name="plus" />
        </button>
        {menu && <Menu items={menuItems} onClose={() => setMenu(false)} />}
      </div>

      <div className="tabbar-spacer" />

      {props.rdp?.web && (
        <div className="tool-group">
          <button className="icon-btn" title="Send Ctrl+Alt+Del" disabled={!props.rdp.connected} onClick={() => props.onRdp('cad')}>
            <Icon name="keyboard" />
          </button>
          <button className="icon-btn" title="Reconnect" onClick={() => props.onRdp('reconnect')}>
            <Icon name="refresh" />
          </button>
          {props.rdp.connected && (
            <button className="icon-btn" title="Disconnect" onClick={() => props.onRdp('disconnect')}>
              <Icon name="plug" />
            </button>
          )}
        </div>
      )}
      {props.rdp && !props.rdp.web && (
        <div className="tool-group">
          <button className="icon-btn" title="Fill a saved login on the current screen (Ctrl+Alt+K)" disabled={!props.rdp.connected} onClick={() => props.onRdp('fill')}>
            <Icon name="keyboard" />
          </button>
          <button className="icon-btn" title="Fullscreen (Ctrl+Alt+Enter)" onClick={() => props.onRdp('fullscreen')}>
            <Icon name="maximize" />
          </button>
          <button className="icon-btn" title="Open in its own window (another monitor)" onClick={() => props.onRdp('popout')}>
            <Icon name="external" />
          </button>
          <button className="icon-btn" title="Reconnect (Ctrl+Alt+R)" onClick={() => props.onRdp('reconnect')}>
            <Icon name="refresh" />
          </button>
          {props.rdp.connected && (
            <button className="icon-btn" title="Disconnect" onClick={() => props.onRdp('disconnect')}>
              <Icon name="plug" />
            </button>
          )}
        </div>
      )}

      {props.hasActive && (
        <div className="tool-group">
          <button className="icon-btn" title="Split right (Alt+Shift+=)" onClick={() => props.onSplit('row')}>
            <Icon name="splitRight" />
          </button>
          <button className="icon-btn" title="Split down (Alt+Shift+-)" onClick={() => props.onSplit('col')}>
            <Icon name="splitDown" />
          </button>
          {props.activePaneCount > 1 && (
            <>
              <button
                className={`icon-btn ${props.zoomed ? 'on' : ''}`}
                title="Zoom pane (Ctrl+Shift+Z)"
                onClick={props.onToggleZoom}
              >
                <Icon name="maximize" />
              </button>
              <button
                className={`icon-btn ${props.broadcast ? 'on warn' : ''}`}
                title="Type into all panes of this tab (Ctrl+Shift+A)"
                onClick={props.onToggleBroadcast}
              >
                <Icon name="broadcast" />
              </button>
            </>
          )}
        </div>
      )}
      <button className="icon-btn" title="Appearance (Ctrl+,)" onClick={props.onAppearance}>
        <Icon name="brush" />
      </button>
    </div>
  );
}
