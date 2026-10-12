import { useCover } from '../rdp';
import type { TabStatus } from '../types';
import { Icon } from './Icon';

export type DropSide = 'left' | 'right' | 'top' | 'bottom';

/** A tab being dragged: where it would land if released now. */
export interface TabDrag {
  key: string;
  title: string;
  kind: string; // pane type of the dragged tab ('rdp', 'ssh', 'local', …)
  status: TabStatus;
  x: number;
  y: number;
  outside: boolean; // pointer left the window
  side: DropSide | null; // over an edge of the visible tab's content: split there
  strip: number | null; // over the tab bar: insertion index
  target: string | null; // the tab whose content is shown (split target)
  restore: string | null; // tab to show again if nothing happens
  canPopOut: boolean; // has Remote Desktop sessions (they can get their own window)
  torn: boolean; // its session window is following the mouse outside Remterm
}

const KIND_ICON: Record<string, string> = { rdp: 'monitor', local: 'terminal', sftp: 'folder', log: 'file' };

/** Drop zones over the content area while a tab is dragged, and the tab under the pointer. */
export function TabDropOverlay({ drag, targetTitle }: { drag: TabDrag; targetTitle?: string }) {
  useCover(); // native RDP windows would hide the zones
  const splitting = !!drag.target && drag.target !== drag.key && !drag.outside && drag.strip === null;
  let hint: string;
  if (drag.outside)
    hint = drag.torn
      ? 'Release to leave it here · move back over Remterm to put it back'
      : drag.canPopOut
        ? `Release to open “${drag.title}” in its own window`
        : 'Only Remote Desktop tabs can open in their own window';
  else if (drag.strip !== null) hint = 'Release to move the tab here';
  else if (drag.side) hint = `Release to put “${drag.title}” on the ${drag.side} of “${targetTitle ?? 'this tab'}”`;
  else if (splitting) hint = 'Move to an edge to see both tabs side by side';
  else hint = drag.canPopOut ? 'Drag outside the window to give it its own window · onto the tab bar to reorder' : 'Drag onto the tab bar to reorder · over the content to split';
  return (
    <>
      <div className="tab-drop">
        {splitting && (
          <>
            {(['left', 'right', 'top', 'bottom'] as DropSide[]).map((s) => (
              <div key={s} className={`tab-drop-edge ${s} ${drag.side === s ? 'on' : ''}`} />
            ))}
          </>
        )}
        {drag.side && <div className={`tab-drop-preview ${drag.side}`}><span>{drag.title}</span></div>}
        <div className={`tab-drop-hint ${drag.outside ? 'outside' : ''}`}>
          <Icon name={drag.outside ? 'external' : drag.side ? 'splitRight' : 'layout'} size={14} />
          {hint}
        </div>
      </div>
      {!drag.outside && (
        <div className="tab-ghost" style={{ left: drag.x, top: drag.y }}>
          <span className={`sdot ${drag.status}`} />
          <Icon name={KIND_ICON[drag.kind] ?? 'server'} size={12} />
          <span className="tab-ghost-title">{drag.title}</span>
        </div>
      )}
    </>
  );
}
