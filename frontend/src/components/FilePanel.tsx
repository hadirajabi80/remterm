import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, cleanError, clipboard, errorMessage } from '../api';
import { transfers } from '../transfers';
import type { FileEntry, Host } from '../types';
import { formatBytes, formatDate, octal } from '../util';
import { PromptDialog } from './fields';
import { Icon } from './Icon';
import { Menu, type MenuItem } from './Menu';
import { ConfirmDialog, Modal } from './Modal';

export interface PanelState {
  fsId: string | null; // null while connecting
  path: string;
}

type SortKey = 'name' | 'size' | 'modified';
const DRAG_TYPE = 'application/x-termora-files';

/**
 * One side of the SFTP view: the local disk or a host. Lists a folder,
 * navigates, and copies to/from the other side (buttons, menu, drag & drop).
 */
export function FilePanel(props: {
  source: string; // 'local' or a host id
  hosts: Host[];
  other: PanelState;
  onSource(source: string): void;
  onState(s: PanelState): void;
  auth(target: string, error: string): Promise<{ password: string; save: boolean } | null>;
  notify(text: string, kind?: 'info' | 'error'): void;
}) {
  const { source } = props;
  const isLocal = source === 'local';
  const host = props.hosts.find((h) => h.id === source);
  const [fsId, setFsId] = useState<string | null>(isLocal ? 'local' : null);
  const [path, setPath] = useState('');
  const [pathText, setPathText] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false });
  const [menu, setMenu] = useState<{ x: number; y: number; entry?: FileEntry } | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'rename'; entry: FileEntry }
    | { kind: 'mkdir' }
    | { kind: 'delete'; paths: string[] }
    | { kind: 'chmod'; entry: FileEntry }
    | null
  >(null);
  const [dropHover, setDropHover] = useState(false);
  const pathRef = useRef(path);
  pathRef.current = path;

  // Connect (or switch) the source.
  useEffect(() => {
    let cancelled = false;
    let opened: string | null = null;
    setEntries([]);
    setSel(new Set());
    setError('');
    if (isLocal) {
      setFsId('local');
      void api.fsHome('local').then((h) => {
        if (!cancelled) void navigate('local', h);
      });
      return () => {
        cancelled = true;
      };
    }
    setFsId(null);
    const connect = async (password = '', save = false): Promise<void> => {
      const sid = crypto.randomUUID();
      try {
        setLoading(true);
        const home = await api.openSftp({ sessionId: sid, hostId: source, password, savePassword: save });
        if (cancelled) {
          void api.closeSftp(sid);
          return;
        }
        opened = sid;
        setFsId(sid);
        await navigate(sid, home);
      } catch (e) {
        if (cancelled) return;
        const msg = errorMessage(e);
        if (msg.startsWith('AUTH_FAILED') || msg.startsWith('PASSPHRASE_REQUIRED')) {
          const res = await props.auth(host?.name ?? 'server', password ? cleanError(msg) : '');
          if (res && !cancelled) return connect(res.password, res.save);
        }
        setError(cleanError(msg));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void connect();
    return () => {
      cancelled = true;
      if (opened) void api.closeSftp(opened);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => props.onState({ fsId, path }), [fsId, path]); // eslint-disable-line react-hooks/exhaustive-deps

  const navigate = useCallback(async (id: string, dir: string) => {
    setLoading(true);
    setError('');
    try {
      const list = await api.fsList(id, dir);
      setEntries(list);
      setPath(dir);
      setPathText(dir);
      setSel(new Set());
    } catch (e) {
      setError(cleanError(errorMessage(e)));
      setPathText(pathRef.current);
    } finally {
      setLoading(false);
    }
  }, []);

  const reload = useCallback(() => fsId && navigate(fsId, pathRef.current), [fsId, navigate]);

  // Refresh when a transfer lands in the folder we show.
  useEffect(() => transfers.onDone((dst, dir) => dst === fsId && dir === pathRef.current && void reload()), [fsId, reload]);

  const shown = useMemo(() => {
    const list = entries.filter((e) => hidden || !e.name.startsWith('.'));
    const dir = sort.desc ? -1 : 1;
    return list.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      if (sort.key === 'size') return (a.size - b.size) * dir;
      if (sort.key === 'modified') return (a.modified - b.modified) * dir;
      return a.name.localeCompare(b.name, undefined, { numeric: true }) * dir;
    });
  }, [entries, hidden, sort]);

  const selected = shown.filter((e) => sel.has(e.path));
  const up = async () => {
    if (!fsId || !path) return;
    const parent = await api.fsParent(fsId, path);
    if (parent !== path) void navigate(fsId, parent);
  };

  const open = (e: FileEntry) => {
    if (!fsId) return;
    if (e.dir) {
      void navigate(fsId, e.path);
      return;
    }
    api
      .fsOpen(fsId, e.path)
      .then(() => !isLocal && props.notify(`Editing ${e.name} — every save uploads it back`))
      .catch((err) => props.notify(cleanError(errorMessage(err)), 'error'));
  };

  const copyToOther = (paths: string[]) => {
    const o = props.other;
    if (!fsId || !o.fsId || !paths.length) return;
    if (!o.path && o.fsId === 'local') {
      props.notify('Open a folder on the other side first', 'error');
      return;
    }
    transfers.start(fsId, paths, o.fsId, o.path).catch((err) => props.notify(cleanError(errorMessage(err)), 'error'));
  };

  const clickRow = (e: React.MouseEvent, entry: FileEntry) => {
    const next = new Set(e.ctrlKey ? sel : []);
    if (e.shiftKey && anchor) {
      const a = shown.findIndex((x) => x.path === anchor);
      const b = shown.findIndex((x) => x.path === entry.path);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(shown[i].path);
    } else if (e.ctrlKey && sel.has(entry.path)) {
      next.delete(entry.path);
    } else {
      next.add(entry.path);
      setAnchor(entry.path);
    }
    setSel(next);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'Enter' && selected.length === 1) open(selected[0]);
    else if (e.key === 'Backspace') void up();
    else if (e.key === 'Delete' && selected.length) setDialog({ kind: 'delete', paths: selected.map((s) => s.path) });
    else if (e.key === 'F2' && selected.length === 1) setDialog({ kind: 'rename', entry: selected[0] });
    else if (e.key === 'F5') void reload();
    else if (e.ctrlKey && e.key.toLowerCase() === 'a') setSel(new Set(shown.map((s) => s.path)));
    else return;
    e.preventDefault();
  };

  // ---- drag & drop between panes ----
  const onDragStart = (e: React.DragEvent, entry: FileEntry) => {
    const paths = sel.has(entry.path) ? selected.map((s) => s.path) : [entry.path];
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ fsId, paths }));
    e.dataTransfer.effectAllowed = 'copy';
  };
  const onDrop = (e: React.DragEvent, into?: FileEntry) => {
    setDropHover(false);
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw || !fsId) return;
    e.preventDefault();
    e.stopPropagation();
    const data = JSON.parse(raw) as { fsId: string; paths: string[] };
    const dstDir = into?.dir ? into.path : path;
    if (data.fsId === fsId && dstDir === path) return; // dropped on itself
    if (data.fsId === fsId) {
      // Same server: move into the folder.
      const join = (dir: string, name: string) => (isLocal ? `${dir.replace(/\\$/, '')}\\${name}` : `${dir.replace(/\/$/, '')}/${name}`);
      Promise.all(data.paths.map((p) => api.fsRename(fsId, p, join(dstDir, p.split(/[\\/]/).pop()!))))
        .then(() => {
          void reload();
        })
        .catch((err) => props.notify(cleanError(errorMessage(err)), 'error'));
      return;
    }
    transfers.start(data.fsId, data.paths, fsId, dstDir).catch((err) => props.notify(cleanError(errorMessage(err)), 'error'));
  };

  const rowMenu = (entry?: FileEntry): (MenuItem | 'sep')[] => {
    const targets = entry ? (sel.has(entry.path) ? selected : [entry]) : [];
    const items: (MenuItem | 'sep')[] = [];
    if (entry) {
      items.push({ label: entry.dir ? 'Open folder' : isLocal ? 'Open' : 'Open / edit', icon: <Icon name="play" size={12} />, onClick: () => open(entry) });
      items.push({
        label: `Copy to ${props.other.fsId === 'local' ? 'this PC' : 'other side'}`,
        hint: '→',
        icon: <Icon name="import" size={13} />,
        onClick: () => copyToOther(targets.map((t) => t.path)),
      });
      items.push('sep');
      if (targets.length === 1) items.push({ label: 'Rename', hint: 'F2', icon: <Icon name="edit" size={13} />, onClick: () => setDialog({ kind: 'rename', entry }) });
      if (!isLocal && targets.length === 1) items.push({ label: 'Permissions…', icon: <Icon name="lock" size={13} />, onClick: () => setDialog({ kind: 'chmod', entry }) });
      items.push({ label: 'Copy path', icon: <Icon name="code" size={13} />, onClick: () => void clipboard.write(targets.map((t) => t.path).join('\n')) });
      items.push({ label: `Delete${targets.length > 1 ? ` ${targets.length} items` : ''}`, hint: 'Del', icon: <Icon name="trash" size={13} />, onClick: () => setDialog({ kind: 'delete', paths: targets.map((t) => t.path) }) });
      items.push('sep');
    }
    items.push({ label: 'New folder', icon: <Icon name="plus" size={13} />, onClick: () => setDialog({ kind: 'mkdir' }) });
    items.push({ label: 'Refresh', hint: 'F5', icon: <Icon name="refresh" size={13} />, onClick: () => void reload() });
    items.push({ label: hidden ? 'Hide hidden files' : 'Show hidden files', onClick: () => setHidden((v) => !v) });
    return items;
  };

  const join = (name: string) => (isLocal ? `${path.replace(/\\$/, '')}\\${name}` : `${path.replace(/\/$/, '')}/${name}`);
  const sortBy = (key: SortKey) => setSort((s) => ({ key, desc: s.key === key ? !s.desc : false }));

  return (
    <div
      className={`file-panel ${dropHover ? 'drop-hover' : ''}`}
      data-fs-panel={fsId ?? ''}
      data-fs-path={path}
      tabIndex={0}
      onKeyDown={onKey}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_TYPE)) {
          e.preventDefault();
          setDropHover(true);
        }
      }}
      onDragLeave={() => setDropHover(false)}
      onDrop={(e) => onDrop(e)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="fp-head">
        <select className="input fp-source" value={source} onChange={(e) => props.onSource(e.target.value)} title="Show files of…">
          <option value="local">💻 This PC</option>
          {props.hosts
            .filter((h) => (h.protocol || 'ssh') === 'ssh')
            .map((h) => (
              <option key={h.id} value={h.id}>
                🖥 {h.name}
              </option>
            ))}
        </select>
        <button className="icon-btn sm" title="Up (Backspace)" onClick={() => void up()} disabled={!path}>
          <Icon name="up" size={14} />
        </button>
        <form
          className="fp-path"
          onSubmit={(e) => {
            e.preventDefault();
            if (fsId) void navigate(fsId, pathText.trim());
          }}
        >
          <input className="input mono" value={pathText} onChange={(e) => setPathText(e.target.value)} placeholder={isLocal ? 'Drives' : '/'} spellCheck={false} />
        </form>
        <button className="icon-btn sm" title="Refresh (F5)" onClick={() => void reload()}>
          <Icon name="refresh" size={13} />
        </button>
        <button className="icon-btn sm" title="New folder" onClick={() => setDialog({ kind: 'mkdir' })} disabled={!path}>
          <Icon name="plus" size={14} />
        </button>
        <button
          className="icon-btn sm"
          title="Copy selection to the other side"
          disabled={!selected.length || !props.other.fsId}
          onClick={() => copyToOther(selected.map((s) => s.path))}
        >
          <Icon name="import" size={14} />
        </button>
      </div>

      <div className="fp-table" onClick={(e) => e.target === e.currentTarget && setSel(new Set())}>
        <div className="fp-row fp-header">
          <button onClick={() => sortBy('name')}>Name{sort.key === 'name' ? (sort.desc ? ' ↓' : ' ↑') : ''}</button>
          <button onClick={() => sortBy('size')}>Size{sort.key === 'size' ? (sort.desc ? ' ↓' : ' ↑') : ''}</button>
          <button onClick={() => sortBy('modified')}>Modified{sort.key === 'modified' ? (sort.desc ? ' ↓' : ' ↑') : ''}</button>
          {!isLocal && <span>Perms</span>}
        </div>
        {!fsId && !error && <div className="fp-msg">Connecting to {host?.name ?? 'server'}…</div>}
        {error && (
          <div className="fp-msg error">
            {error}
            {fsId && (
              <button className="btn sm" onClick={() => void reload()}>
                Retry
              </button>
            )}
          </div>
        )}
        {fsId && !error && !loading && shown.length === 0 && <div className="fp-msg">Empty folder — drop files here</div>}
        {shown.map((e) => (
          <div
            key={e.path}
            className={`fp-row ${sel.has(e.path) ? 'sel' : ''} ${e.dir ? 'dir' : ''}`}
            draggable
            onDragStart={(ev) => onDragStart(ev, e)}
            onDragOver={(ev) => e.dir && ev.dataTransfer.types.includes(DRAG_TYPE) && ev.preventDefault()}
            onDrop={(ev) => e.dir && onDrop(ev, e)}
            onClick={(ev) => clickRow(ev, e)}
            onDoubleClick={() => open(e)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              if (!sel.has(e.path)) setSel(new Set([e.path]));
              setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
            }}
            title={e.path}
          >
            <span className="fp-name">
              <span className={`fp-ico ${e.dir ? 'dir' : ''}`}>{e.mode === 'drive' ? '🖴' : e.dir ? '📁' : fileIcon(e.name)}</span>
              {e.name}
              {e.link && <span className="hint"> ↪</span>}
            </span>
            <span className="fp-size">{e.dir ? '' : formatBytes(e.size)}</span>
            <span className="fp-date">{formatDate(e.modified)}</span>
            {!isLocal && <span className="fp-perm mono">{e.mode.slice(-9)}</span>}
          </div>
        ))}
      </div>
      <div className="fp-foot">
        <span>
          {shown.length} items{selected.length ? ` · ${selected.length} selected (${formatBytes(selected.reduce((s, x) => s + (x.dir ? 0 : x.size), 0))})` : ''}
        </span>
        {loading && <span>Loading…</span>}
      </div>

      {menu && (
        <Menu items={rowMenu(menu.entry)} at={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />
      )}
      {dialog?.kind === 'mkdir' && fsId && (
        <PromptDialog
          title="New folder"
          label="Folder name"
          confirmLabel="Create"
          onCancel={() => setDialog(null)}
          onSubmit={async (name) => {
            if (!name.trim()) return;
            await api.fsMkdir(fsId, join(name.trim()));
            setDialog(null);
            void reload();
          }}
        />
      )}
      {dialog?.kind === 'rename' && fsId && (
        <PromptDialog
          title={`Rename ${dialog.entry.name}`}
          label="New name"
          initial={dialog.entry.name}
          confirmLabel="Rename"
          onCancel={() => setDialog(null)}
          onSubmit={async (name) => {
            if (!name.trim() || name === dialog.entry.name) return setDialog(null);
            await api.fsRename(fsId, dialog.entry.path, join(name.trim()));
            setDialog(null);
            void reload();
          }}
        />
      )}
      {dialog?.kind === 'delete' && fsId && (
        <ConfirmDialog
          title="Delete"
          message={
            dialog.paths.length === 1
              ? `Delete ${dialog.paths[0].split(/[\\/]/).pop()}${isLocal ? '' : ` from ${host?.name}`}? Folders are deleted with everything inside. This cannot be undone.`
              : `Delete ${dialog.paths.length} items? Folders are deleted with everything inside. This cannot be undone.`
          }
          confirmLabel="Delete"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            setDialog(null);
            try {
              await api.fsDelete(fsId, dialog.paths);
            } catch (err) {
              props.notify(cleanError(errorMessage(err)), 'error');
            }
            void reload();
          }}
        />
      )}
      {dialog?.kind === 'chmod' && fsId && (
        <PermissionsDialog
          entry={dialog.entry}
          onCancel={() => setDialog(null)}
          onSave={async (perm) => {
            await api.fsChmod(fsId, dialog.entry.path, perm);
            setDialog(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) return '🖼';
  if (['zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'xz'].includes(ext)) return '🗜';
  if (['sh', 'ps1', 'bat', 'cmd', 'exe', 'dll'].includes(ext)) return '⚙';
  if (['log', 'txt', 'md'].includes(ext)) return '📄';
  if (['json', 'yml', 'yaml', 'xml', 'conf', 'env', 'ini', 'toml'].includes(ext)) return '🧾';
  return '📄';
}

function PermissionsDialog(props: { entry: FileEntry; onSave(perm: number): Promise<void>; onCancel(): void }) {
  const [perm, setPerm] = useState(props.entry.perm & 0o777);
  const [error, setError] = useState('');
  const bit = (who: number, what: number) => 1 << ((2 - who) * 3 + (2 - what));
  return (
    <Modal
      title={`Permissions — ${props.entry.name}`}
      onClose={props.onCancel}
      width={380}
      footer={
        <>
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => props.onSave(perm).catch((e) => setError(cleanError(errorMessage(e))))}
          >
            Apply
          </button>
        </>
      }
    >
      <div className="stack">
        {error && <div className="error-box">{error}</div>}
        <table className="perm-table">
          <thead>
            <tr>
              <th />
              <th>Read</th>
              <th>Write</th>
              <th>Execute</th>
            </tr>
          </thead>
          <tbody>
            {['Owner', 'Group', 'Others'].map((label, who) => (
              <tr key={label}>
                <td>{label}</td>
                {[0, 1, 2].map((what) => (
                  <td key={what}>
                    <input type="checkbox" checked={!!(perm & bit(who, what))} onChange={() => setPerm(perm ^ bit(who, what))} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <label className="field">
          Octal
          <input
            className="input mono"
            value={octal(perm)}
            onChange={(e) => /^[0-7]{0,3}$/.test(e.target.value) && setPerm(parseInt(e.target.value || '0', 8))}
          />
        </label>
      </div>
    </Modal>
  );
}
