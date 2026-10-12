import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cover, rdp } from '../rdp';
import type { Pane } from '../types';
import { Icon } from './Icon';

/**
 * Placeholder for one RDP session. The session itself is a native window
 * (owned by the RDP engine) laid exactly over this element; it is hidden
 * whenever the tab is not shown, a dialog or menu covers the page, or the
 * app is locked — then a still picture of the session is shown here instead.
 */
export function RdpView(props: {
  id: string;
  pane: Pane;
  shown: boolean; // tab visible and pane not hidden by zoom
  active: boolean;
  locked: boolean;
  onRetry(): void;
  onClose(): void;
}) {
  const { id, pane } = props;
  const ref = useRef<HTMLDivElement>(null);
  const covered = useSyncExternalStore(cover.subscribe, cover.get);
  const [frozen, setFrozen] = useState(false);
  const [snap, setSnap] = useState('');
  const mode = pane.rdpMode ?? 'docked';
  const ready = !!pane.rdpReady;
  const docked = mode === 'docked';

  // Covered: grab a still of the live session first, then hide the native window.
  useEffect(() => {
    if (!covered) {
      setFrozen(false);
      setSnap('');
      return;
    }
    if (!(props.shown && docked && ready && pane.status === 'connected')) {
      setFrozen(true);
      return;
    }
    let cancelled = false;
    rdp
      .snapshot(id)
      .then((img) => !cancelled && setSnap(img))
      .catch(() => {})
      .finally(() => !cancelled && setFrozen(true));
    return () => {
      cancelled = true;
    };
  }, [covered]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = props.shown && docked && ready && !frozen && !props.locked;

  // Keep the native window on top of this element: size, position, visibility.
  useEffect(() => {
    if (!ready) return;
    const el = ref.current!;
    let last = '';
    const push = (force = false) => {
      const r = el.getBoundingClientRect();
      const s = window.devicePixelRatio || 1;
      const rect = { x: Math.round(r.left * s), y: Math.round(r.top * s), w: Math.round(r.width * s), h: Math.round(r.height * s) };
      const key = `${rect.x},${rect.y},${rect.w},${rect.h},${visible}`;
      if (!force && key === last) return;
      last = key;
      void rdp.bounds(id, rect, visible).catch(() => {});
    };
    push(true);
    let raf = 0;
    const later = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => push());
    };
    const ro = new ResizeObserver(later);
    ro.observe(el);
    window.addEventListener('resize', later);
    const iv = window.setInterval(push, 400); // catches moves that change no size (sidebar, splits)
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', later);
      window.clearInterval(iv);
    };
  }, [id, visible, ready]);

  // Give the session the keyboard when its tab comes forward.
  useEffect(() => {
    if (visible && props.active) void rdp.focus(id).catch(() => {});
  }, [visible, props.active, id]);

  const failed = !ready && pane.status === 'disconnected';
  return (
    <div className="rdp-view" ref={ref}>
      {frozen && snap && <img className="rdp-snap" src={snap} alt="" draggable={false} />}
      {!ready && !failed && (
        <div className="rdp-card">
          <div className="rdp-spinner" />
          <div className="rdp-card-title">{pane.message || 'Starting Remote Desktop…'}</div>
        </div>
      )}
      {failed && (
        <div className="rdp-card">
          <Icon name="monitor" size={30} />
          <div className="rdp-card-title">{pane.title}</div>
          <div className="rdp-card-text">{pane.message || 'Not connected.'}</div>
          <div className="row-btns center">
            <button className="btn primary" onClick={props.onRetry}>
              Try again
            </button>
            <button className="btn" onClick={props.onClose}>
              Close tab
            </button>
          </div>
        </div>
      )}
      {ready && !docked && (
        <div className="rdp-card">
          <Icon name={mode === 'fullscreen' ? 'maximize' : 'external'} size={30} />
          <div className="rdp-card-title">{pane.title} is {mode === 'fullscreen' ? 'fullscreen' : 'in its own window'}</div>
          <div className="rdp-card-text">
            {mode === 'fullscreen' ? 'Press Ctrl+Alt+Enter or use the bar at the top of the screen to come back.' : 'Drag it to another monitor, or bring it back into this tab.'}
          </div>
          <div className="row-btns center">
            <button className="btn primary" onClick={() => void rdp.dock(id)}>
              Bring back into tab
            </button>
            <button className="btn" onClick={() => void rdp.focus(id)}>
              Show window
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
