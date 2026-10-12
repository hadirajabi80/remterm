import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CursorAnchor } from '../autocomplete';
import { history } from '../history';
import { useCover } from '../rdp';
import { timeAgo } from '../util';

const WIDTH = 620;

/**
 * Command history opened with ↑ at a prompt. The newest entry sits next to
 * the prompt and is selected; the arrow pointing away from the prompt walks
 * back in time, the other one forward (and past the newest closes the list).
 */
export function HistoryList(props: {
  query: string;
  hostKey: string;
  anchor: CursorAnchor | null;
  hostLabel(key: string): string;
  onPick(command: string, run: boolean): void;
  onClose(): void;
}) {
  useCover();
  const [query, setQuery] = useState(props.query);
  const version = useSyncExternalStore(history.subscribe, history.getVersion);
  const items = useMemo(() => history.search(query, props.hostKey), [query, props.hostKey, version]);
  const [sel, setSel] = useState(items.length - 1);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSel(items.length - 1), [query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    listRef.current?.querySelector('.hitem.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel, items]);

  // Above the cursor when there is room, otherwise below it.
  const a = props.anchor ?? { left: 80, top: window.innerHeight - 80, bottom: window.innerHeight - 60 };
  const above = a.top > 240;
  const left = Math.max(8, Math.min(a.left - 24, window.innerWidth - WIDTH - 8));
  const style: React.CSSProperties = above
    ? { left, bottom: window.innerHeight - a.top + 6 }
    : { left, top: a.bottom + 6 };

  const current = items[sel];
  const pick = (run: boolean) => current && props.onPick(current.command, run);

  return (
    <div className="history-backdrop" onMouseDown={props.onClose}>
      <div className={`history-list ${above ? 'above' : 'below'}`} style={style} onMouseDown={(e) => e.stopPropagation()}>
        <div className="hl-items" ref={listRef}>
          {items.length === 0 && (
            <div className="hl-empty">
              {query ? 'No matching commands.' : 'No history yet — commands you run are remembered here.'}
            </div>
          )}
          {(above ? items : [...items].reverse()).map((it, j) => {
            const i = above ? j : items.length - 1 - j;
            return (
            <div
              key={it.command}
              className={`hitem ${i === sel ? 'sel' : ''}`}
              onMouseMove={() => setSel(i)}
              onClick={(e) => props.onPick(it.command, !e.shiftKey)}
              title="Click to run · Shift+click to insert"
            >
              <span className="hcmd">{it.command}</span>
              <span className={`hhost ${it.here ? 'here' : ''}`}>
                {it.here ? 'this server' : props.hostLabel(it.hostKeys[it.hostKeys.length - 1])}
              </span>
              <span className="htime">{timeAgo(it.lastUsed)}</span>
            </div>
            );
          })}
        </div>
        <div className="hl-input">
          <span className="hl-prompt">history ›</span>
          <input
            autoFocus
            value={query}
            spellCheck={false}
            placeholder="type to filter"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              const older = above ? 'ArrowUp' : 'ArrowDown';
              const newer = above ? 'ArrowDown' : 'ArrowUp';
              if (e.key === older) {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === newer) {
                e.preventDefault();
                if (sel >= items.length - 1) props.onClose();
                else setSel((s) => s + 1);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pick(true);
              } else if (e.key === 'Tab') {
                e.preventDefault();
                pick(false);
              } else if (e.key === 'Delete' && e.shiftKey && current) {
                e.preventDefault();
                history.remove(current.command);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                props.onClose();
              }
            }}
          />
          <span className="hl-keys">
            <kbd>Enter</kbd> run <kbd>Tab</kbd> edit <kbd>Shift+Del</kbd> forget
          </span>
        </div>
      </div>
    </div>
  );
}
