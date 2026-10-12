import { useState, useSyncExternalStore } from 'react';
import { history } from '../history';
import type { Host, Snippet } from '../types';
import { groupBy, hostLabel, matches, timeAgo } from '../util';
import { Icon } from './Icon';
import { SnippetInfo } from './SnippetInfo';

export type Panel = 'hosts' | 'snippets' | 'history';

export function Sidebar(props: {
  hosts: Host[];
  snippets: Snippet[];
  panel: Panel;
  onPanel(p: Panel): void;
  hasSession: boolean;
  onConnect(h: Host): void;
  onEditHost(h: Host | null): void;
  onDeleteHost(h: Host): void;
  onImport(): void;
  onRunSnippet(s: Snippet, execute: boolean): void;
  onEditSnippet(s: Snippet | null): void;
  onDeleteSnippet(s: Snippet): void;
  historyHostLabel(key: string): string;
  onRunHistory(command: string, execute: boolean): void;
  onClearHistory(): void;
}) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = props.snippets.find((s) => s.id === selectedId);
  const toggle = (g: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  const isHosts = props.panel === 'hosts';
  const isSnippets = props.panel === 'snippets';
  const isHistory = props.panel === 'history';
  const historyVersion = useSyncExternalStore(history.subscribe, history.getVersion);
  const historyItems = isHistory ? history.recent(query) : [];
  void historyVersion;
  const hostGroups = groupBy(
    props.hosts.filter((h) => matches(query, h.name, h.address, h.user, h.group, h.env)),
    (h) => h.group,
  );
  const snippetGroups = groupBy(
    props.snippets.filter((s) => matches(query, s.name, s.command, s.group, s.description)),
    (s) => s.group,
  );

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo">
          <Icon name="terminal" size={16} />
        </div>
        <div>
          <div className="brand-name">Termora</div>
          <div className="brand-sub">SSH workspace</div>
        </div>
      </div>

      <div className="seg">
        <button className={isHosts ? 'on' : ''} onClick={() => props.onPanel('hosts')}>
          <Icon name="server" size={14} /> Hosts <span className="seg-count">{props.hosts.length}</span>
        </button>
        <button className={isSnippets ? 'on' : ''} onClick={() => props.onPanel('snippets')}>
          <Icon name="code" size={14} /> Snippets
        </button>
        <button className={isHistory ? 'on' : ''} onClick={() => props.onPanel('history')}>
          <Icon name="refresh" size={14} /> History
        </button>
      </div>

      <div className="side-tools">
        <label className="search">
          <Icon name="search" size={14} />
          <input placeholder={isHosts ? 'Filter hosts' : isSnippets ? 'Filter snippets' : 'Search commands'} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {isHosts && (
          <button className="icon-btn boxed" title="Import from ~/.ssh/config" onClick={props.onImport}>
            <Icon name="import" size={15} />
          </button>
        )}
        {isHistory ? (
          <button className="icon-btn boxed danger" title="Clear all history" onClick={props.onClearHistory}>
            <Icon name="trash" size={15} />
          </button>
        ) : (
          <button
            className="icon-btn boxed accent"
            title={isHosts ? 'New host' : 'New snippet'}
            onClick={() => (isHosts ? props.onEditHost(null) : props.onEditSnippet(null))}
          >
            <Icon name="plus" size={15} />
          </button>
        )}
      </div>

      <div className="side-list">
        {isHistory && historyItems.length === 0 && (
          <div className="side-empty">
            <p>{query ? 'No matching commands.' : 'Commands you run in any terminal show up here.'}</p>
            <p className="hint">Press ↑ at a prompt to pick from history, → to accept the gray suggestion.</p>
          </div>
        )}
        {isHistory &&
          historyItems.map((it) => (
            <div
              key={it.command}
              className="row history-row"
              tabIndex={0}
              title={`${it.command}\n\nDouble-click to run in the active terminal`}
              onDoubleClick={() => props.onRunHistory(it.command, true)}
            >
              <div className="row-main">
                <div className="row-title mono">{it.command}</div>
                <div className="row-sub desc">
                  {props.historyHostLabel(it.hostKeys[it.hostKeys.length - 1])}
                  {it.hostKeys.length > 1 ? ` +${it.hostKeys.length - 1}` : ''} · {timeAgo(it.lastUsed)}
                  {it.count > 1 ? ` · ×${it.count}` : ''}
                </div>
              </div>
              <div className="row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                <button className="icon-btn sm" title="Run" disabled={!props.hasSession} onClick={() => props.onRunHistory(it.command, true)}>
                  <Icon name="play" size={12} />
                </button>
                <button className="icon-btn sm" title="Insert without running" disabled={!props.hasSession} onClick={() => props.onRunHistory(it.command, false)}>
                  <Icon name="insert" size={13} />
                </button>
                <button className="icon-btn sm danger" title="Forget" onClick={() => history.remove(it.command)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>
          ))}
        {isHosts && props.hosts.length === 0 && (
          <div className="side-empty">
            <p>No hosts yet.</p>
            <button className="btn primary sm" onClick={() => props.onEditHost(null)}>
              Add a host
            </button>
            <button className="btn sm" onClick={props.onImport}>
              Import ~/.ssh/config
            </button>
          </div>
        )}

        {isHosts &&
          hostGroups.map(([group, hosts]) => {
            const key = 'h:' + group;
            const open = !collapsed.has(key) || !!query;
            return (
              <section key={key}>
                <button className={`group-head ${open ? 'open' : ''}`} onClick={() => toggle(key)}>
                  <span className="chev">
                    <Icon name="chevron" size={12} />
                  </span>
                  {group || 'Ungrouped'}
                  <span className="group-count">{hosts.length}</span>
                </button>
                {open &&
                  hosts.map((h) => (
                    <div
                      key={h.id}
                      className="row"
                      tabIndex={0}
                      title="Double-click or Enter to connect"
                      onDoubleClick={() => props.onConnect(h)}
                      onKeyDown={(e) => e.key === 'Enter' && props.onConnect(h)}
                    >
                      <span className={`host-ico env-${h.env || 'none'}`}>
                        <Icon name="server" size={14} />
                      </span>
                      <div className="row-main">
                        <div className="row-title">
                          {h.name}
                          {h.env === 'prod' && <span className="mini-badge prod">PROD</span>}
                        </div>
                        <div className="row-sub">{hostLabel(h)}</div>
                      </div>
                      <div className="row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                        <button className="icon-btn sm" title="Connect" onClick={() => props.onConnect(h)}>
                          <Icon name="play" size={12} />
                        </button>
                        <button className="icon-btn sm" title="Edit" onClick={() => props.onEditHost(h)}>
                          <Icon name="edit" size={13} />
                        </button>
                        <button className="icon-btn sm danger" title="Delete" onClick={() => props.onDeleteHost(h)}>
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
              </section>
            );
          })}

        {isSnippets && !props.hasSession && props.snippets.length > 0 && (
          <div className="side-note">Open a connection to run snippets.</div>
        )}
        {!isHosts &&
          snippetGroups.map(([group, snippets]) => {
            const key = 's:' + group;
            const open = !collapsed.has(key) || !!query;
            return (
              <section key={key}>
                <button className={`group-head ${open ? 'open' : ''}`} onClick={() => toggle(key)}>
                  <span className="chev">
                    <Icon name="chevron" size={12} />
                  </span>
                  {group || 'General'}
                  <span className="group-count">{snippets.length}</span>
                </button>
                {open &&
                  snippets.map((s) => (
                    <div
                      key={s.id}
                      className={`row ${s.id === selectedId ? 'selected' : ''}`}
                      tabIndex={0}
                      title="Click for details, double-click to run"
                      onClick={() => setSelectedId(s.id)}
                      onFocus={() => setSelectedId(s.id)}
                      onDoubleClick={() => props.onRunSnippet(s, true)}
                      onKeyDown={(e) => e.key === 'Enter' && props.onRunSnippet(s, true)}
                    >
                      <div className="row-main">
                        <div className="row-title">{s.name}</div>
                        <div className={`row-sub ${s.description ? 'desc' : ''}`}>{s.description || s.command}</div>
                      </div>
                      <div className="row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                        <button className="icon-btn sm" title="Run (sends Enter)" disabled={!props.hasSession} onClick={() => props.onRunSnippet(s, true)}>
                          <Icon name="play" size={12} />
                        </button>
                        <button className="icon-btn sm" title="Insert without running" disabled={!props.hasSession} onClick={() => props.onRunSnippet(s, false)}>
                          <Icon name="insert" size={13} />
                        </button>
                        <button className="icon-btn sm" title="Edit" onClick={() => props.onEditSnippet(s)}>
                          <Icon name="edit" size={13} />
                        </button>
                        <button className="icon-btn sm danger" title="Delete" onClick={() => props.onDeleteSnippet(s)}>
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
              </section>
            );
          })}
      </div>

      {isSnippets && selected && (
        <SnippetInfo
          snippet={selected}
          canRun={props.hasSession}
          onRun={(execute) => props.onRunSnippet(selected, execute)}
          onEdit={() => props.onEditSnippet(selected)}
          onClose={() => setSelectedId(null)}
        />
      )}

      <div className="side-foot">
        <kbd>Ctrl</kbd>
        <kbd>Shift</kbd>
        <kbd>P</kbd>
        <span>Command palette</span>
      </div>
    </aside>
  );
}
