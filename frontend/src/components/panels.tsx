import { useCallback, useEffect, useState } from 'react';
import { api, cleanError, errorMessage } from '../api';
import type { KnownHost, LogEntry } from '../types';
import { formatBytes, matches, timeAgo } from '../util';
import { Icon } from './Icon';
import { ConfirmDialog } from './Modal';
import { PromptDialog } from './fields';
import { SearchBox, type SidebarCtx } from './Sidebar';

// ---------------- Keychain ----------------

export function KeychainPanel({ ctx }: { ctx: SidebarCtx }) {
  const keyName = (id: string) => ctx.keys.find((k) => k.id === id)?.label;
  return (
    <div className="side-list padded">
      <div className="sec-head">
        <span>Keys</span>
        <span className="sec-actions">
          <button className="link" onClick={ctx.importKey}>
            Import
          </button>
          <button className="link" onClick={ctx.generateKey}>
            + Generate
          </button>
        </span>
      </div>
      {ctx.keys.length === 0 && <div className="side-note">No keys yet. Generate an Ed25519 key, then use "Install on a server" to stop typing passwords.</div>}
      {ctx.keys.map((k) => {
        const used = ctx.hosts.filter((h) => h.keyId === k.id).length + ctx.identities.filter((i) => i.keyId === k.id).length;
        return (
          <div key={k.id} className="row" tabIndex={0} onClick={() => ctx.openKey(k)} onKeyDown={(e) => e.key === 'Enter' && ctx.openKey(k)} title="Open key details">
            <span className="host-ico env-none">
              <Icon name="key" size={14} />
            </span>
            <div className="row-main">
              <div className="row-title">
                {k.label}
                {k.certificate && <span className="mini-badge proto">CERT</span>}
              </div>
              <div className="row-sub">
                {k.type.replace('ssh-', '')} · {k.fingerprint.slice(7, 19)}… {used ? `· used by ${used}` : ''}
              </div>
            </div>
          </div>
        );
      })}

      <div className="sec-head">
        <span>Identities</span>
        <span className="sec-actions">
          <button className="link" onClick={() => ctx.editIdentity(null)}>
            + New
          </button>
        </span>
      </div>
      {ctx.identities.length === 0 && <div className="side-note">An identity is a username + password/key you can attach to many hosts or a whole group.</div>}
      {ctx.identities.map((i) => (
        <div key={i.id} className="row" tabIndex={0} onClick={() => ctx.editIdentity(i)} onKeyDown={(e) => e.key === 'Enter' && ctx.editIdentity(i)}>
          <span className="host-ico env-none">
            <Icon name="user" size={14} />
          </span>
          <div className="row-main">
            <div className="row-title">{i.label}</div>
            <div className="row-sub">
              {i.username}
              {i.keyId ? ` · key: ${keyName(i.keyId) ?? 'deleted'}` : ''}
              {i.hasPassword ? ' · password' : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------- Port forwarding ----------------

export function TunnelsPanel({ ctx }: { ctx: SidebarCtx }) {
  const hostName = (id: string) => ctx.hosts.find((h) => h.id === id)?.name ?? 'deleted host';
  return (
    <>
      <div className="side-tools">
        <button className="btn primary sm grow" onClick={() => ctx.editTunnel(null)}>
          <Icon name="plus" size={12} /> New port forwarding
        </button>
      </div>
      <div className="side-list">
        {ctx.tunnels.length === 0 && (
          <div className="side-empty">
            <p>No rules yet.</p>
            <p className="hint">Example: Local 5433 → 127.0.0.1:5432 through your DB server lets you open the production database at localhost:5433.</p>
          </div>
        )}
        {ctx.tunnels.map((t) => {
          const st = ctx.tunnelStatus[t.id]?.state ?? 'stopped';
          const err = ctx.tunnelStatus[t.id]?.error;
          const on = st === 'running' || st === 'starting';
          return (
            <div key={t.id} className="row tunnel-row" tabIndex={0} onDoubleClick={() => ctx.toggleTunnel(t)} title={err || 'Double-click to start/stop'}>
              <span className={`sdot ${st === 'running' ? 'connected' : st === 'starting' ? 'connecting' : st === 'error' ? 'disconnected' : ''}`} />
              <div className="row-main">
                <div className="row-title">
                  {t.label}
                  <span className="mini-badge proto">{t.type === 'dynamic' ? 'SOCKS' : t.type.toUpperCase()}</span>
                  {t.autoStart && <span className="mini-badge dev">AUTO</span>}
                </div>
                <div className="row-sub">
                  {t.type === 'remote' ? `server:${t.port} → ${t.destHost}:${t.destPort}` : t.type === 'dynamic' ? `socks5://127.0.0.1:${t.port}` : `localhost:${t.port} → ${t.destHost}:${t.destPort}`} via{' '}
                  {hostName(t.hostId)}
                </div>
                {st === 'error' && err && <div className="row-sub err">{err}</div>}
              </div>
              <div className="row-actions show" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                <label className="switch" title={on ? 'Stop' : 'Start'}>
                  <input type="checkbox" checked={on} onChange={() => ctx.toggleTunnel(t)} />
                  <i />
                </label>
                <button className="icon-btn sm" title="Edit" onClick={() => ctx.editTunnel(t)}>
                  <Icon name="edit" size={13} />
                </button>
                <button className="icon-btn sm danger" title="Delete" onClick={() => ctx.deleteTunnel(t)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------------- Workspaces ----------------

export function WorkspacesPanel({ ctx }: { ctx: SidebarCtx }) {
  return (
    <>
      <div className="side-tools">
        <button className="btn primary sm grow" disabled={!ctx.canSaveWorkspace} onClick={ctx.saveWorkspace} title="Ctrl+S">
          <Icon name="layout" size={12} /> Save current tab as workspace
        </button>
      </div>
      <div className="side-list">
        {ctx.workspaces.length === 0 && (
          <div className="side-empty">
            <p>No saved workspaces.</p>
            <p className="hint">Split a tab into the servers you work with together (e.g. API + DB + logs), then save it to reopen the whole layout in one click.</p>
          </div>
        )}
        {ctx.workspaces.map((w) => {
          const n = Object.keys(w.data?.targets ?? {}).length;
          return (
            <div key={w.id} className="row" tabIndex={0} onDoubleClick={() => ctx.openWorkspace(w)} onKeyDown={(e) => e.key === 'Enter' && ctx.openWorkspace(w)}>
              <span className="host-ico env-none">
                <Icon name="layout" size={14} />
              </span>
              <div className="row-main">
                <div className="row-title">{w.name}</div>
                <div className="row-sub desc">{n} pane{n === 1 ? '' : 's'}</div>
              </div>
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn sm" title="Open" onClick={() => ctx.openWorkspace(w)}>
                  <Icon name="play" size={12} />
                </button>
                <button className="icon-btn sm" title="Rename" onClick={() => ctx.renameWorkspace(w)}>
                  <Icon name="edit" size={13} />
                </button>
                <button className="icon-btn sm danger" title="Delete" onClick={() => ctx.deleteWorkspace(w)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------------- Session logs ----------------

export function LogsPanel({ ctx }: { ctx: SidebarCtx }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [query, setQuery] = useState('');
  const [onlyStarred, setOnlyStarred] = useState(false);
  const [comment, setComment] = useState<LogEntry | null>(null);
  const reload = useCallback(() => api.listLogs().then(setLogs).catch(() => {}), []);
  useEffect(() => {
    void reload();
    const t = window.setInterval(reload, 5000);
    return () => window.clearInterval(t);
  }, [reload]);
  const shown = logs.filter((l) => (!onlyStarred || l.bookmarked) && matches(query, l.title, l.comment));
  return (
    <>
      <SearchBox value={query} onChange={setQuery} placeholder="Filter logs">
        <button className={`icon-btn boxed ${onlyStarred ? 'on' : ''}`} title="Bookmarked only" onClick={() => setOnlyStarred((v) => !v)}>
          <Icon name="star" size={14} />
        </button>
      </SearchBox>
      <div className="side-list">
        {shown.length === 0 && (
          <div className="side-empty">
            <p>{logs.length ? 'No matching logs.' : 'No session logs yet.'}</p>
            <p className="hint">Each terminal session is recorded (the last 5 per server). Bookmark one to keep it. Passwords typed at hidden prompts are never recorded.</p>
          </div>
        )}
        {shown.map((l) => (
          <div key={l.id} className="row" tabIndex={0} onDoubleClick={() => ctx.openLog(l.id, l.title)} onKeyDown={(e) => e.key === 'Enter' && ctx.openLog(l.id, l.title)} title="Double-click to view">
            <span className={`host-ico ${l.bookmarked ? 'env-staging' : 'env-none'}`}>
              <Icon name={l.bookmarked ? 'star' : 'file'} size={14} />
            </span>
            <div className="row-main">
              <div className="row-title">{l.title}</div>
              <div className="row-sub desc">
                {timeAgo(l.started)} · {l.ended ? formatBytes(l.size) : 'recording…'}
                {l.comment ? ` · ${l.comment}` : ''}
              </div>
            </div>
            <div className="row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
              <button className="icon-btn sm" title="View" onClick={() => ctx.openLog(l.id, l.title)}>
                <Icon name="play" size={12} />
              </button>
              <button
                className={`icon-btn sm ${l.bookmarked ? 'on warn' : ''}`}
                title={l.bookmarked ? 'Remove bookmark' : 'Bookmark (keep forever)'}
                onClick={() => (l.bookmarked ? api.setLogBookmark(l.id, false, '').then(reload) : setComment(l))}
              >
                <Icon name="star" size={13} />
              </button>
              <button
                className="icon-btn sm"
                title="Export as text"
                onClick={() =>
                  api
                    .exportLog(l.id)
                    .then((p) => p && ctx.notify(`Saved ${p}`))
                    .catch((e) => ctx.notify(errorMessage(e), 'error'))
                }
              >
                <Icon name="import" size={13} />
              </button>
              <button className="icon-btn sm danger" title="Delete" onClick={() => api.deleteLog(l.id).then(reload)}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {comment && (
        <PromptDialog
          title="Bookmark log"
          label="Note (optional)"
          placeholder="Why keep this? e.g. migration of DB on Oct 12"
          confirmLabel="Bookmark"
          onCancel={() => setComment(null)}
          onSubmit={async (text) => {
            await api.setLogBookmark(comment.id, true, text);
            setComment(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

// ---------------- Known hosts ----------------

export function KnownHostsPanel({ ctx }: { ctx: SidebarCtx }) {
  const [list, setList] = useState<KnownHost[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [remove, setRemove] = useState<KnownHost | null>(null);
  const reload = useCallback(
    () =>
      api
        .listKnownHosts()
        .then((l) => {
          setList(l);
          setError('');
        })
        .catch((e) => setError(cleanError(errorMessage(e)))),
    [],
  );
  useEffect(() => void reload(), [reload]);
  const shown = list.filter((k) => matches(query, k.hosts, k.keyType, k.fingerprint));
  return (
    <>
      <SearchBox value={query} onChange={setQuery} placeholder="Filter servers" />
      <div className="side-list">
        <div className="side-note">Server fingerprints you trusted (~/.ssh/known_hosts, shared with OpenSSH). Remove one if a server was reinstalled and its key changed.</div>
        {error && <div className="error-box">{error}</div>}
        {shown.map((k) => (
          <div key={k.line} className="row">
            <span className="host-ico env-none">
              <Icon name="shield" size={14} />
            </span>
            <div className="row-main">
              <div className="row-title mono">{k.hosts}</div>
              <div className="row-sub" title={k.fingerprint}>
                {k.keyType.replace('ssh-', '')} · {k.fingerprint.slice(7, 23)}…{k.marker ? ` · ${k.marker}` : ''}
              </div>
            </div>
            <div className="row-actions">
              <button className="icon-btn sm danger" title="Remove" onClick={() => setRemove(k)}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {remove && (
        <ConfirmDialog
          title="Remove known host"
          message={`Forget the key of ${remove.hosts}? You will be asked to verify the server's fingerprint on the next connection.`}
          confirmLabel="Remove"
          danger
          onCancel={() => setRemove(null)}
          onConfirm={async () => {
            await api.removeKnownHost(remove.line).catch((e) => ctx.notify(errorMessage(e), 'error'));
            setRemove(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

