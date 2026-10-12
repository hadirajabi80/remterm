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

const SCALE_FIT = 1; // iron-remote-desktop ScreenScale.Fit

/** Logical size of the tab, even, within what RDP servers accept. */
function sizeOf(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const even = (n: number, min: number) => Math.max(min, Math.min(8192, Math.round(n))) & ~1;
  return { width: even(r.width, 640), height: even(r.height, 480) };
}

const LOGIN_ERRORS = new Set([1, 2]); // WrongPassword, LogonFailure
const ERROR_TEXT: Record<number, string> = {
  1: 'Wrong user name or password.',
  2: 'The server refused the login — check the user name and password.',
  3: 'Access denied.',
  4: 'Could not reach the server.',
  5: 'Could not reach the server.',
  6: 'The server refused the connection settings (security negotiation failed).',
};

function describeError(e: unknown): { text: string; login: boolean } {
  const err = e as { kind?: () => number; backtrace?: () => string };
  if (typeof err?.kind === 'function') {
    const kind = err.kind();
    const detail = typeof err.backtrace === 'function' ? err.backtrace().split('\n')[0] : '';
    return { text: ERROR_TEXT[kind] ?? (detail || 'The connection failed.'), login: LOGIN_ERRORS.has(kind) };
  }
  return { text: errorMessage(e), login: false };
}

interface LoginForm {
  username: string;
  password: string;
  remember: boolean;
  error: string;
  mode: 'bastion' | 'direct';
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
  const [login, setLogin] = useState<LoginForm | null>(null);
  const typed = useRef<{ username: string; password: string } | null>(null); // from the login form, for this tab
  const ui = useRef<any>(null);
  const status = props.pane.status;

  useEffect(() => {
    const el = host.current!;
    let cancelled = false;
    let comp: HTMLElement | null = null;
    let mode: LoginForm['mode'] = 'direct';
    let loginUser = '';
    props.onStatus('connecting', 'Connecting…');

    (async () => {
      const info = await rdp.webSession({ ...props.request, ...(typed.current ?? {}) });
      if (cancelled) return;
      mode = info.mode;
      loginUser = info.loginUser;
      if (info.needsLogin) {
        setLogin({ username: info.loginUser, password: '', remember: true, error: '', mode: info.mode });
        props.onStatus('disconnected', 'Enter your user name and password');
        return;
      }

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
      user.setScale(SCALE_FIT); // the whole remote screen inside the tab: nothing cut off right or bottom
      user.setEnableClipboard(true);

      const config = user
        .configBuilder()
        .withUsername(info.username)
        .withPassword(info.password)
        .withDestination(info.destination)
        .withProxyAddress(info.proxy)
        .withServerDomain(info.domain)
        .withAuthToken(info.token)
        .withDesktopSize(sizeOf(el))
        .withExtension(iron.displayControl(true))
        .build();
      const session = await user.connect(config);
      if (cancelled) {
        user.shutdown();
        return;
      }
      user.setVisibility(true);
      user.setScale(SCALE_FIT);
      setLogin(null);
      props.onStatus('connected', '');
      const end = await session.run();
      if (!cancelled) props.onStatus('disconnected', `Session ended: ${end?.reason?.() ?? 'disconnected'}`);
    })().catch((e) => {
      if (cancelled) return;
      const err = describeError(e);
      if (err.login) {
        // Ask again right here instead of sending the user to the settings.
        setLogin({ username: typed.current?.username ?? loginUser, password: '', remember: true, error: err.text, mode });
        props.onStatus('disconnected', err.text);
      } else props.onStatus('disconnected', err.text);
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

  // Follow the tab size (fullscreen, sidebar, window): the server changes its resolution when it can.
  useEffect(() => {
    const el = host.current!;
    let t = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        if (status !== 'connected' || !ui.current) return;
        const s = sizeOf(el);
        try {
          ui.current.resize(s.width, s.height);
        } catch {
          /* not supported by this server: the picture is scaled to fit */
        }
        ui.current.setScale(SCALE_FIT);
      }, 300);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, [status]);

  const focus = () => (host.current?.querySelector('iron-remote-desktop') as HTMLElement | null)?.focus();
  useEffect(() => {
    if (props.active && status === 'connected') requestAnimationFrame(focus);
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

  const submitLogin = async (f: LoginForm) => {
    if (!f.username.trim() || !f.password) {
      setLogin({ ...f, error: 'Enter the user name and the password.' });
      return;
    }
    typed.current = { username: f.username.trim(), password: f.password };
    if (f.remember) {
      await rdp.rememberLogin({ machineId: props.request.machineId, mode: f.mode, username: f.username.trim(), password: f.password }).catch(() => {});
    }
    setLogin(null);
    setAttempt((n) => n + 1);
  };

  return (
    <div className="rdp-view web-rdp">
      <div className="web-rdp-host" ref={host} />
      {login ? (
        <div className="rdp-card">
          <form
            className="rdp-login"
            onSubmit={(e) => {
              e.preventDefault();
              void submitLogin(login);
            }}
          >
            <div className="rdp-login-head">
              <span className="rdp-login-ico">
                <Icon name={login.mode === 'direct' ? 'monitor' : 'shield'} size={20} />
              </span>
              <div>
                <div className="rdp-card-title">Sign in to {props.pane.title}</div>
                <div className="hint">{login.mode === 'direct' ? props.pane.subtitle : 'Your WALLIX bastion login'}</div>
              </div>
            </div>
            {login.error && <div className="error-box">{login.error}</div>}
            <label className="field">
              {login.mode === 'direct' ? 'User name' : 'Bastion user name'}
              <input
                className="input"
                autoFocus={!login.username}
                placeholder={login.mode === 'direct' ? 'DOMAIN\\user or user' : 'user'}
                value={login.username}
                onChange={(e) => setLogin({ ...login, username: e.target.value })}
              />
            </label>
            <label className="field">
              Password
              <input className="input" type="password" autoFocus={!!login.username} value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={login.remember} onChange={(e) => setLogin({ ...login, remember: e.target.checked })} />
              Remember {login.mode === 'direct' ? 'for this machine' : 'for all bastion connections'} (saved in the Keychain)
            </label>
            <div className="row-btns">
              <button className="btn primary" type="submit">
                Connect
              </button>
              <button className="btn" type="button" onClick={props.onClose}>
                Close tab
              </button>
            </div>
          </form>
        </div>
      ) : (
        status !== 'connected' && (
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
        )
      )}
    </div>
  );
}
