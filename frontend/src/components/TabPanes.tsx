import { useMemo, useRef } from 'react';
import { computeLayout, leaves, type Divider, type Rect } from '../layout';
import type { TermSession } from '../terminal';
import type { Pane, Tab } from '../types';
import { Icon } from './Icon';
import { TermView } from './TermView';
import type { ReactNode } from 'react';

const FULL: Rect = { x: 0, y: 0, w: 100, h: 100 };

/**
 * Renders every pane of a tab absolutely positioned from the split tree.
 * Panes stay mounted in a stable order while the tree changes, so xterm
 * instances are never re-parented.
 */
export function TabPanes(props: {
  tab: Tab;
  visible: boolean;
  panes: Record<string, Pane>;
  sessions: Map<string, TermSession>;
  onActivate(paneKey: string): void;
  onRatio(splitKey: string, ratio: number): void;
  onClosePane(paneKey: string): void;
  /** Content for non-terminal panes (SFTP, log viewer, Remote Desktop); shown = on screen now. */
  renderPane(pane: Pane, active: boolean, shown: boolean): ReactNode;
}) {
  const { tab } = props;
  const ref = useRef<HTMLDivElement>(null);
  const { panes: rects, dividers } = useMemo(() => computeLayout(tab.layout), [tab.layout]);
  const keys = useMemo(() => leaves(tab.layout), [tab.layout]);
  const stable = useMemo(() => [...keys].sort(), [keys]);
  const multi = keys.length > 1;

  const startDrag = (d: Divider, e: React.MouseEvent) => {
    e.preventDefault();
    const box = ref.current!.getBoundingClientRect();
    const start = d.dir === 'row' ? d.rect.x : d.rect.y;
    const size = d.dir === 'row' ? d.rect.w : d.rect.h;
    const move = (ev: MouseEvent) => {
      const pos =
        d.dir === 'row' ? ((ev.clientX - box.left) / box.width) * 100 : ((ev.clientY - box.top) / box.height) * 100;
      props.onRatio(d.key, Math.min(0.9, Math.max(0.1, (pos - start) / size)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('dragging-row', 'dragging-col');
    };
    document.body.classList.add(d.dir === 'row' ? 'dragging-row' : 'dragging-col');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div ref={ref} className={`tab-panes ${props.visible ? 'visible' : ''}`}>
      {stable.map((k) => {
        const pane = props.panes[k];
        const session = props.sessions.get(k);
        const terminal = pane?.target.kind === 'ssh' || pane?.target.kind === 'local';
        if (!pane || (terminal && !session)) return null;
        const r = tab.zoomed ? (k === tab.activePane ? FULL : null) : rects.get(k);
        const isActive = k === tab.activePane;
        return (
          <div
            key={k}
            data-pane-key={k}
            className={`pane pane-${pane.target.kind} ${multi && !tab.zoomed ? 'multi' : ''} ${multi && isActive && !tab.zoomed ? 'active' : ''} ${r ? '' : 'hidden'} ${tab.broadcast && multi ? 'broadcast' : ''}`}
            style={r ? { left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` } : undefined}
            onMouseDown={() => !isActive && props.onActivate(k)}
          >
            {terminal ? <TermView session={session!} active={props.visible && isActive} /> : props.renderPane(pane, props.visible && isActive, props.visible && !!r)}
            {multi && !tab.zoomed && (
              <div className="pane-head">
                <span className={`sdot ${pane.status}`} />
                {pane.env && <span className={`mini-badge ${pane.env}`}>{pane.env.toUpperCase()}</span>}
                <span className="pane-head-title">{pane.subtitle}</span>
                <button
                  className="pane-close"
                  title="Close pane (Ctrl+Shift+W)"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => props.onClosePane(k)}
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            )}
          </div>
        );
      })}
      {!tab.zoomed &&
        dividers.map((d) => (
          <div
            key={d.key}
            className={`split-divider ${d.dir}`}
            style={
              d.dir === 'row'
                ? { left: `${d.at}%`, top: `${d.rect.y}%`, height: `${d.rect.h}%` }
                : { top: `${d.at}%`, left: `${d.rect.x}%`, width: `${d.rect.w}%` }
            }
            title="Drag to resize, double-click to even out"
            onMouseDown={(e) => startDrag(d, e)}
            onDoubleClick={() => props.onRatio(d.key, 0.5)}
          />
        ))}
    </div>
  );
}
