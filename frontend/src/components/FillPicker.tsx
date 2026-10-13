import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Modal } from './Modal';

/** A saved login offered by the RDP engine (names only; the engine types the picked one). */
export interface FillChoice {
  key: string;
  label: string;
  sub: string;
  bastion: boolean;
}

/** Ctrl+Alt+K: pick a login and it is typed on whatever the session shows. */
export function FillPicker(props: { entries: FillChoice[]; onPick(key: string): void; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const items = props.entries.filter((e) => tokens.every((t) => `${e.label} ${e.sub}`.toLowerCase().includes(t)));
  const cur = Math.min(sel, Math.max(0, items.length - 1));

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('.fill-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [cur]);

  const pick = (i: number) => {
    const e = items[i];
    if (e) props.onPick(e.key);
  };

  return (
    <Modal title="Fill login" onClose={props.onClose} width={480}>
      <div className="fill-picker">
        <p className="hint">Pick a login — it is typed on the screen the session shows now.</p>
        <input
          className="input"
          autoFocus
          placeholder="Search…  (or press 1–9)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel(Math.min(cur + 1, items.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel(Math.max(cur - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(cur);
            } else if (/^[1-9]$/.test(e.key) && !query) {
              e.preventDefault();
              pick(Number(e.key) - 1);
            }
          }}
        />
        <div className="fill-list" ref={listRef}>
          {items.length === 0 && <div className="side-empty">No matching login.</div>}
          {items.map((e, i) => (
            <button key={e.key} className={`fill-item ${i === cur ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => pick(i)}>
              <span className="fill-num">{i < 9 ? i + 1 : ''}</span>
              <span className={`fill-ico ${e.bastion ? 'bastion' : ''}`}>
                <Icon name={e.bastion ? 'shield' : 'key'} size={14} />
              </span>
              <span className="fill-label">{e.label}</span>
              <span className="fill-sub">{e.sub}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
