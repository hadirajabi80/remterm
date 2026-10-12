import { useEffect, useMemo, useRef, useState } from 'react';
import { RDP_HOST_RE, useCover } from '../rdp';
import { looksLikeSpec, matches } from '../util';
import { Icon } from './Icon';

export interface PaletteItem {
  id: string;
  kind: 'Connect' | 'Remote' | 'Local' | 'Run' | 'Action';
  label: string;
  detail?: string;
  env?: string;
  keywords?: string; // searched but not shown
  /** split: Shift+Enter / Shift+click — open in a split pane instead of a new tab. */
  run(opts?: { split?: boolean }): void;
}

const KIND_ICON: Record<PaletteItem['kind'], string> = { Connect: 'server', Remote: 'monitor', Local: 'terminal', Run: 'code', Action: 'bolt' };

export function CommandPalette(props: {
  items: PaletteItem[];
  onQuickConnect(spec: string, split: boolean): void;
  /** Direct Remote Desktop to a typed IP/host (when RDP is available). */
  onQuickRdp?(host: string, split: boolean): void;
  onClose(): void;
}) {
  useCover();
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const list = props.items.filter((it) => matches(query, it.kind, it.label, it.detail, it.keywords));
    const q = query.trim();
    if (props.onQuickRdp && RDP_HOST_RE.test(q) && !list.some((it) => it.kind === 'Remote' && it.detail?.includes(q))) {
      list.push({ id: 'quick-rdp', kind: 'Remote', label: `Remote Desktop to ${q}`, detail: 'direct RDP', run: (o) => props.onQuickRdp!(q, !!o?.split) });
    }
    if (looksLikeSpec(query)) {
      const spec = query.trim().replace(/^ssh\s+/, '');
      const quick: PaletteItem = {
        id: 'quick',
        kind: 'Connect',
        label: `Quick connect to ${spec}`,
        detail: 'Enter',
        run: (o) => props.onQuickConnect(spec, !!o?.split),
      };
      return query.includes('@') || list.length === 0 ? [quick, ...list] : [...list, quick];
    }
    return list;
  }, [props, query]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('.pitem.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const run = (it: PaletteItem | undefined, split = false) => {
    if (!it) return;
    props.onClose();
    it.run({ split });
  };

  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            placeholder="Search hosts, machines, snippets, actions — or type user@host / an IP to connect"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(results[sel], e.shiftKey);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                props.onClose();
              }
            }}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && <div className="palette-empty">No matches</div>}
          {results.map((it, i) => (
            <div
              key={it.id}
              className={`pitem ${i === sel ? 'sel' : ''}`}
              onMouseMove={() => setSel(i)}
              onClick={(e) => run(it, e.shiftKey)}
            >
              <span className={`pitem-ico ${it.env ? 'env-' + it.env : ''}`}>
                <Icon name={KIND_ICON[it.kind]} size={14} />
              </span>
              <span className="pkind">{it.kind}</span>
              <span className="plabel">{it.label}</span>
              {it.detail && <span className="pdetail">{it.detail}</span>}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>Enter</kbd> run
          </span>
          <span>
            <kbd>Shift</kbd>
            <kbd>Enter</kbd> open in split
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
