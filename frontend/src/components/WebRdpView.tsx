import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api';
import { rdp, type OpenRequest } from '../rdp';
import type { Pane, TabStatus } from '../types';
import { Icon } from './Icon';

/**
 * Remote Desktop inside the tab without the Windows RDP control (macOS): the
 * IronRDP web component renders the session on a canvas in the page and
 * connects through Remterm's local relay (rdpproxy.go).
 */

type IronModule = { Backend: unknown; displayControl(enable: boolean): unknown };
let ironLoaded: Promise<IronModule> | null = null;

function loadIron(): Promise<IronModule> {
  // ~6 MB of WebAssembly: only loaded the first time a session opens.
  ironLoaded ??= (async () => {
    await import('@devolutions/iron-remote-desktop'); // registers <iron-remote-desktop>
    const m = await import('@devolutions/iron-remote-desktop-rdp');
    await m.init('WARN');
    return { Backend: m.Backend, displayControl: m.displayControl };
  })();
  return ironLoaded;
}

/** What App's toolbar and shortcuts can ask a web session to do. */
export interface WebRdpHandle {
  reconnect(): void;
  disconnect(): void;
  ctrlAltDel(): void;
  focus(): void;
}
export const webRdpSessions = new Map<string, WebRdpHandle>();

const ERROR_TEXT: Record<number, string> = {
  1: 'Wrong user name or password.',
  2: 'The server refused the login.',
  3: 'Access denied.',
  4: 'Could not reach the server.',
  5: 'Could not reach the server.',
  6: 'The server refused the connection settings (security negotiation failed).',
};

function describeError(e: unknown): string {
  const err = e as { kind?: () => number; backtrace?: () => string };
  if (typeof err?.kind === 'function') {
    const kind = err.kind();
    const detail = typeof err.backtrace === 'function' ? err.backtrace().split('\n')[0] : '';
    return ERROR_TEXT[kind] ?? (detail || 'The connection failed.');
  }
  return errorMessage(e);
}

export function WebRdpView(props: {
  id: string;
  pane: Pane;
  request: Omit<OpenRequest, 'id'>;
  active: boolean;
  onStatus(status: TabStatus, message?: string): void;
  onClose(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const ui = useRef<any>(null);
  const status = props.pane.status;

  useEffect(() => {
    const el = host.current!;
    let cancelled = false;
    let comp: HTMLElement | null = null;
    props.onStatus('connecting', 'Connecting…');

    (async () => {
      const iron = await loadIron();
      if (cancelled) return;
      comp = document.createElement('iron-remote-desktop');
      comp.setAttribute('scale', 'fit');
      comp.setAttribute('flexcenter', 'true');
      comp.setAttribute('flexcentre', 'true');
      comp.setAttribute('verbose', 'false');
      (comp as any).module = iron.Backend;
      const ready = new Promise<any>((resolve) => comp!.addEventListener('ready', (e) => resolve((e as CustomEvent).detail.irgUserInteraction), { once: true }));
      el.appendChild(comp);
      const user = await ready;
      if (cancelled) return;
      ui.current = user;

      const info = await rdp.webSession(props.request);
      if (cancelled) return;
      const r = el.getBoundingClientRect();
      const s = window.devicePixelRatio || 1;
      const size = { width: Math.max(800, Math.round(r.width * s)) & ~1, height: Math.max(600, Math.round(r.height * s)) & ~1 };
      user.setEnableClipboard(true);
      const config = user
        .configBuilder()
        .withUsername(info.username)
        .withPassword(info.password)
        .withDestination(info.destination)
        .withProxyAddress(info.proxy)
        .withServerDomain(info.domain)
        .withAuthToken(info.token)
        .withDesktopSize(size)
        .withExtension(iron.displayControl(true))
        .build();
      const session = await user.connect(config);
      if (cancelled) {
        user.shutdown();
        return;
      }
      user.setVisibility(true);
      props.onStatus('connected', '');
      const end = await session.run();
      if (!cancelled) props.onStatus('disconnected', `Session ended: ${end?.reason?.() ?? 'disconnected'}`);
    })().catch((e) => {
      if (!cancelled) props.onStatus('disconnected', describeError(e));
    });

    return () => {
      cancelled = true;
      try {
        ui.current?.shutdown();
      } catch {
        /* already closed */
      }
      ui.current = null;
      comp?.remove();
    };
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the tab size (the server changes its resolution when it supports it).
  useEffect(() => {
    const el = host.current!;
    let t = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        const s = window.devicePixelRatio || 1;
        if (r.width > 100 && r.height > 100 && status === 'connected') {
          try {
            ui.current?.resize(Math.round(r.width * s) & ~1, Math.round(r.height * s) & ~1);
          } catch {
            /* not supported by this server */
          }
        }
      }, 400);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, [status]);

  const focus = () => (host.current?.querySelector('iron-remote-desktop') as HTMLElement | null)?.focus();
  useEffect(() => {
    if (props.active) requestAnimationFrame(focus);
  }, [props.active, status]);

  useEffect(() => {
    webRdpSessions.set(props.id, {
      reconnect: () => setAttempt((n) => n + 1),
      disconnect: () => ui.current?.shutdown(),
      ctrlAltDel: () => ui.current?.ctrlAltDel(),
      focus,
    });
    return () => {
      webRdpSessions.delete(props.id);
    };
  }, [props.id]);

  return (
    <div className="rdp-view web-rdp">
      <div className="web-rdp-host" ref={host} />
      {status !== 'connected' && (
        <div className="rdp-card">
          {status === 'disconnected' ? (
            <>
              <Icon name="monitor" size={30} />
              <div className="rdp-card-title">{props.pane.title}</div>
              <div className="rdp-card-text">{props.pane.message || 'Disconnected.'}</div>
              <div className="row-btns center">
                <button className="btn primary" onClick={() => setAttempt((n) => n + 1)}>
                  Reconnect
                </button>
                <button className="btn" onClick={props.onClose}>
                  Close tab
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="rdp-spinner" />
              <div className="rdp-card-title">Connecting to {props.pane.title}…</div>
              <div className="rdp-card-text">{props.pane.subtitle}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
