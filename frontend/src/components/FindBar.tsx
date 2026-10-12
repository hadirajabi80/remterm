import { useState } from 'react';
import type { TermSession } from '../terminal';
import { Icon } from './Icon';

const DECORATIONS = {
  matchBackground: '#3b4b78',
  activeMatchBackground: '#e0af68',
  matchOverviewRuler: '#7aa2f7',
  activeMatchColorOverviewRuler: '#e0af68',
};

export function FindBar({ session, onClose }: { session: TermSession; onClose(): void }) {
  const [q, setQ] = useState('');
  const find = (dir: 1 | -1, query = q) => {
    if (!query) return;
    const opts = { decorations: DECORATIONS };
    if (dir === 1) session.search.findNext(query, opts);
    else session.search.findPrevious(query, opts);
  };
  const close = () => {
    session.search.clearDecorations();
    onClose();
    session.focus();
  };

  return (
    <div className="findbar">
      <Icon name="search" size={14} />
      <input
        autoFocus
        placeholder="Find in terminal"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          find(1, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') find(e.shiftKey ? -1 : 1);
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        }}
      />
      <button className="icon-btn sm" title="Previous (Shift+Enter)" onClick={() => find(-1)}>
        <Icon name="up" size={14} />
      </button>
      <button className="icon-btn sm" title="Next (Enter)" onClick={() => find(1)}>
        <Icon name="down" size={14} />
      </button>
      <button className="icon-btn sm" title="Close (Esc)" onClick={close}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
