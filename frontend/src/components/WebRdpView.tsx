import { useEffect, useRef, useState } from 'react';
import { errorMessage, rdpDownload } from '../api';
import { rdp, type OpenRequest } from '../rdp';
import { RdpDownloadLifecycle, RdpStallGuard, streamRdpDownload } from '../rdpDownloads';
import type { Pane, TabStatus } from '../types';
import { Icon } from './Icon';
import ironUiUrl from '@devolutions/iron-remote-desktop/iron-remote-desktop.js?url';
import ironRdpUrl from '@devolutions/iron-remote-desktop-rdp/iron-remote-desktop-rdp.js?url';
import type { FileInfo, TransferProgress, FileTransferError } from '@devolutions/iron-remote-desktop-rdp';

/**
 * Remote Desktop inside the tab without the Windows RDP control (macOS): the
 * IronRDP web component renders the session on a canvas in the page and
 * connects through Remterm's local relay (rdpproxy.go).
 */

// The component sizes itself to its *window*, not its container, so it runs in an
// iframe exactly the size of the tab: there "the window" is the tab and the remote
// screen fits it. Both packages are self-contained ES modules (WebAssembly inlined).
const IRON_UI = new URL(ironUiUrl, location.href).href;
const IRON_RDP = new URL(ironRdpUrl, location.href).href;
const FRAME_DOC =
  '<!doctype html><html><head><meta charset="utf-8"><style>' +
  'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0d1117}' +
  'iron-remote-desktop{display:block;width:100%;height:100%;outline:none}' +
  '</style></head><body></body></html>';

/** Loads the component into a new iframe inside `host`; resolves with its window and the RDP module. */
async function createFrame(host: HTMLElement): Promise<{ frame: HTMLIFrameElement; win: any; iron: any }> {
  const frame = document.createElement('iframe');
  frame.className = 'web-rdp-frame';
  frame.setAttribute('allow', 'clipboard-read; clipboard-write');
  frame.srcdoc = FRAME_DOC;
  const loaded = new Promise((r) => frame.addEventListener('load', r, { once: true }));
  host.appendChild(frame);
  await loaded;
  const win = frame.contentWindow as any;
  await new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error('The Remote Desktop component did not load.')), 30000);
    win.addEventListener(
      'iron-ready',
      () => {
        window.clearTimeout(t);
        resolve();
      },
      { once: true },
    );
    const s = win.document.createElement('script');
    s.type = 'module';
    s.textContent =
      `import ${JSON.stringify(IRON_UI)};` +
      `import * as rdp from ${JSON.stringify(IRON_RDP)};` +
      `await rdp.init('WARN'); window.__iron = rdp; window.dispatchEvent(new Event('iron-ready'));`;
    win.document.head.appendChild(s);
  });
  return { frame, win, iron: win.__iron };
}
/** What App's toolbar and shortcuts can ask a web session to do. */
export interface WebRdpHandle {
  reconnect(): void;
  disconnect(): void;
  ctrlAltDel(): void;
  focus(): void;
  /** Small JPEG of the remote screen for the tab's hover preview ('' when there is none). */
  thumb(): string;
}
export const webRdpSessions = new Map<string, WebRdpHandle>();

const SCALE_FIT = 1; // iron-remote-desktop ScreenScale.Fit
const MAX_NATIVE_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_STALL_MS = 60_000;
interface AvailableRemoteFile {
  info: FileInfo;
  index: number;
  list: FileInfo[];
  revision: number;
}
interface FileTransferUiState {
  state: 'saving' | 'downloading' | 'writing' | 'done' | 'error';
  progress: number;
  error?: string;
}
const remoteFileKey = (file: AvailableRemoteFile) => `${file.revision}:${file.index}:${file.info.path ?? ''}:${file.info.name}`;
const formatBytes = (size: number) => {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
};

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
  /** Keep connected: reconnect when the session drops and keep it from idling out. */
  keepAlive?: boolean;
  onStatus(status: TabStatus, message?: string): void;
  onClose(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [login, setLogin] = useState<LoginForm | null>(null);
  const typed = useRef<{ username: string; password: string } | null>(null); // from the login form, for this tab
  const ui = useRef<any>(null);
  const status = props.pane.status;
  const keepAlive = useRef(!!props.keepAlive);
  keepAlive.current = !!props.keepAlive;
  const userEnded = useRef(false); // Disconnect pressed: no automatic reconnect
  const retries = useRef(0);
  const downloadLifecycle = useRef(new RdpDownloadLifecycle<FileInfo[]>());
  const downloadAction = useRef<((file: AvailableRemoteFile) => void) | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [availableFiles, setAvailableFiles] = useState<AvailableRemoteFile[]>([]);
  const [transferUi, setTransferUi] = useState<Record<string, FileTransferUiState>>({});
  const [filesOpen, setFilesOpen] = useState(false);
  const [clipboardEnabled, setClipboardEnabled] = useState(true);
  const [clipboardWarning, setClipboardWarning] = useState('');

  useEffect(() => {
    const el = host.current!;
    let cancelled = false;
    let comp: HTMLElement | null = null;
    let frame: HTMLIFrameElement | null = null;
    let mode: LoginForm['mode'] = 'direct';
    let loginUser = '';
    let retryTimer = 0;
    let idleTimer = 0;
    const generation = downloadLifecycle.current.start();
    let sessionAlive = true;
    let sessionUser: any = null;
    let stoppedTransferReason = '';
    let transferProvider: import('@devolutions/iron-remote-desktop-rdp').RdpFileTransferProvider | null = null;
    let activeTransfer: { id: number; key: string } | null = null;
    let stallGuard: RdpStallGuard | null = null;
    const stopStallWatch = () => {
      stallGuard?.clear();
      stallGuard = null;
    };
    let activeNativeId = '';
    let fileListRevision = 0;
    const clearFiles = () => {
      setAvailableFiles([]);
      setTransferUi({});
      setFilesOpen(false);
    };
    clearFiles();
    setDownloading(false);
    setClipboardEnabled(true);
    setClipboardWarning('');
    userEnded.current = false;
    props.onStatus(retries.current ? 'reconnecting' : 'connecting', 'Connecting…');

    // Keep connected: try again after 5, 10, 20, 40, then every 60 seconds.
    const retry = (why: string) => {
      if (cancelled || !keepAlive.current || userEnded.current || retries.current >= 15) return false;
      let left = Math.min(60, 5 << Math.min(retries.current, 4));
      retries.current++;
      const show = () => props.onStatus('reconnecting', `${why} — keep connected is on, reconnecting in ${left} s…`);
      show();
      retryTimer = window.setInterval(() => {
        if (--left > 0) return show();
        window.clearInterval(retryTimer);
        setAttempt((n) => n + 1);
      }, 1000);
      return true;
    };

    (async () => {
      const info = await rdp.webSession({ ...props.request, ...(typed.current ?? {}) });
      if (cancelled) return;
      mode = info.mode;
      loginUser = info.loginUser;
      const allowClipboard = info.redirectClipboard !== false;
      setClipboardEnabled(allowClipboard);
      if (info.needsLogin) {
        setLogin({ username: info.loginUser, password: '', remember: true, error: '', mode: info.mode });
        props.onStatus('disconnected', 'Enter your user name and password');
        return;
      }

      const made = await createFrame(el);
      frame = made.frame;
      if (cancelled) {
        frame.remove();
        return;
      }
      const { win, iron } = made;
      // Remterm's Ctrl+Alt shortcuts still work while the session has the keyboard.
      win.addEventListener(
        'keydown',
        (e: KeyboardEvent) => {
          if ((e.ctrlKey || e.metaKey) && e.altKey && /^(PageUp|PageDown|[1-9]|k|K|l|L|p|P)$/.test(e.key)) {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: true, shiftKey: e.shiftKey, bubbles: true }));
          }
        },
        true,
      );
      comp = win.document.createElement('iron-remote-desktop') as HTMLElement;
      comp.setAttribute('scale', 'fit');
      comp.setAttribute('flexcenter', 'true');
      comp.setAttribute('flexcentre', 'true');
      comp.setAttribute('verbose', 'false');
      (comp as any).module = iron.Backend;
      const ready = new Promise<any>((resolve) => comp!.addEventListener('ready', (e) => resolve((e as CustomEvent).detail.irgUserInteraction), { once: true }));
      win.document.body.appendChild(comp);
      const user = await ready;
      if (cancelled) {
        user.shutdown();
        return;
      }
      sessionUser = user;
      ui.current = user;
      user.setScale(SCALE_FIT); // the whole remote screen inside the tab: nothing cut off right or bottom
      user.setEnableClipboard(allowClipboard);
      user.onWarningCallback((warning: string) => {
        if (!cancelled && downloadLifecycle.current.isCurrent(generation)) setClipboardWarning(warning);
      });

      if (allowClipboard) {
        const provider: import('@devolutions/iron-remote-desktop-rdp').RdpFileTransferProvider = new iron.RdpFileTransferProvider();
        transferProvider = provider;
        user.enableFileTransfer(provider);
        const current = () => !cancelled && sessionAlive && downloadLifecycle.current.isCurrent(generation);
        const stopSession = (reason: string) => {
          if (!current()) return;
          stoppedTransferReason = reason;
          sessionAlive = false;
          userEnded.current = true;
          downloadLifecycle.current.end(generation);
          clearFiles();
          setDownloading(false);
          setClipboardWarning(reason);
          props.onStatus('disconnected', reason);
          stallGuard?.clear();
          if (activeNativeId) void rdpDownload.cancel(activeNativeId).catch(() => {});
          try {
            provider.dispose();
            user.shutdown();
          } catch {
            /* already closed */
          }
        };
        provider.on('files-available', (files: FileInfo[]) => {
          if (!current()) return;
          downloadLifecycle.current.publishFiles(generation, files);
          const revision = ++fileListRevision;
          setAvailableFiles(files.map((info, index) => ({ info, index, list: files, revision })));
          setTransferUi({});
        });
        provider.on('download-progress', (progress: TransferProgress) => {
          if (!current() || !activeTransfer || activeTransfer.id !== progress.transferId) return;
          if (progress.totalBytes > MAX_NATIVE_DOWNLOAD_BYTES) {
            stopSession(`This file is larger than the ${formatBytes(MAX_NATIVE_DOWNLOAD_BYTES)} download limit. Reconnect to continue.`);
            return;
          }
          stallGuard?.activity();
          const progressKey = activeTransfer.key;
          setTransferUi((old) => ({ ...old, [progressKey]: { state: 'downloading', progress: Math.max(0, Math.min(100, progress.percentage)) } }));
        });
        provider.on('error', (error: FileTransferError) => {
          if (!current() || error.direction === 'upload') return;
          if (typeof error.fileIndex !== 'number') return;
          const key = `:${error.fileIndex}:`;
          setTransferUi((old) => {
            const match = Object.keys(old).find((entry) => entry.includes(key));
            return match ? { ...old, [match]: { state: 'error', progress: old[match].progress, error: error.message } } : old;
          });
        });
        downloadAction.current = (file) => {
          const key = remoteFileKey(file);
          if (file.info.isDirectory || file.info.size > MAX_NATIVE_DOWNLOAD_BYTES) return;
          if (!current() || activeTransfer || !downloadLifecycle.current.reserve(generation, file.list)) return;
          setDownloading(true);
          void (async () => {
            setTransferUi((old) => ({ ...old, [key]: { state: 'saving', progress: 0 } }));
            let nativeId = '';
            try {
              // Open the native save dialog directly from the click, before requesting remote bytes.
              nativeId = await rdpDownload.begin(file.info.name, file.info.size);
              if (!nativeId) {
                if (current()) setTransferUi((old) => ({ ...old, [key]: { state: 'error', progress: 0, error: 'Save canceled.' } }));
                return;
              }
              if (!current() || downloadLifecycle.current.currentFiles(generation) !== file.list) {
                await rdpDownload.cancel(nativeId).catch(() => {});
                return;
              }
              activeNativeId = nativeId;
              const handle = provider.downloadFile(file.info, file.index);
              activeTransfer = { id: handle.transferId, key };
              stallGuard = new RdpStallGuard(DOWNLOAD_STALL_MS, () => stopSession('The file transfer stopped responding. Reconnect to try again.'));
              stallGuard.activity();
              setTransferUi((old) => ({ ...old, [key]: { state: 'downloading', progress: 0 } }));
              const blob = await handle.completion;
              stallGuard?.clear(); // bytes are local now: local streaming must not stall-kill the session
              if (!current()) throw new Error('The RDP session ended during the download.');
              if (blob.size > MAX_NATIVE_DOWNLOAD_BYTES) {
                stopSession(`This file is larger than the ${formatBytes(MAX_NATIVE_DOWNLOAD_BYTES)} download limit. Reconnect to continue.`);
                throw new Error(`The file is larger than the ${formatBytes(MAX_NATIVE_DOWNLOAD_BYTES)} download limit.`);
              }
              if (file.info.size > 0 && file.info.size !== blob.size) {
                throw new Error(`The remote reported ${formatBytes(file.info.size)}, but sent ${formatBytes(blob.size)}.`);
              }
              setTransferUi((old) => ({ ...old, [key]: { state: 'writing', progress: 100 } }));
              await streamRdpDownload(blob, nativeId, rdpDownload, current, () => {});
              nativeId = '';
              activeNativeId = '';
              if (current()) setTransferUi((old) => ({ ...old, [key]: { state: 'done', progress: 100 } }));
            } catch (error) {
              stallGuard?.clear();
              if (nativeId) await rdpDownload.cancel(nativeId).catch(() => {});
              if (current()) setTransferUi((old) => ({ ...old, [key]: { state: 'error', progress: 0, error: errorMessage(error) } }));
            } finally {
              stopStallWatch();
              activeTransfer = null;
              if (activeNativeId === nativeId) activeNativeId = '';
              downloadLifecycle.current.release(generation);
              if (current()) setDownloading(false);
            }
          })();
        };
      } else {
        downloadAction.current = null;
      }

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
      retries.current = 0;
      props.onStatus('connected', '');

      // Nobody working in the session for a while: a tiny mouse move keeps the server from signing it out.
      let lastInput = Date.now();
      for (const ev of ['keydown', 'mousedown', 'mousemove', 'wheel']) win.addEventListener(ev, (e: Event) => e.isTrusted && (lastInput = Date.now()), true);
      idleTimer = window.setInterval(() => {
        if (!keepAlive.current || Date.now() - lastInput < 240_000) return;
        lastInput = Date.now();
        const canvas = (comp?.shadowRoot?.querySelector('canvas') ?? win.document.querySelector('canvas')) as HTMLCanvasElement | null;
        const r = canvas?.getBoundingClientRect();
        if (!canvas || !r) return;
        for (const dx of [1, 0]) {
          canvas.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, composed: true, clientX: r.left + r.width / 2 + dx, clientY: r.top + r.height / 2 }));
        }
      }, 20_000);

      const end = await session.run();
      sessionAlive = false;
      if (downloadLifecycle.current.end(generation)) {
        clearFiles();
        setDownloading(false);
      }
      stopStallWatch();
      activeTransfer = null;
      if (activeNativeId) {
        await rdpDownload.cancel(activeNativeId).catch(() => {});
        activeNativeId = '';
      }
      try {
        transferProvider?.dispose();
        user.shutdown();
      } catch {
        /* session already ended */
      }
      window.clearInterval(idleTimer);
      const why = `Session ended: ${end?.reason?.() ?? 'disconnected'}`;
      if (!cancelled && !stoppedTransferReason && !retry(why)) props.onStatus('disconnected', why);
    })().catch((e) => {
      if (cancelled) return;
      window.clearInterval(idleTimer);
      sessionAlive = false;
      if (downloadLifecycle.current.end(generation)) {
        clearFiles();
        setDownloading(false);
      }
      stopStallWatch();
      activeTransfer = null;
      if (activeNativeId) {
        void rdpDownload.cancel(activeNativeId).catch(() => {});
        activeNativeId = '';
      }
      try {
        transferProvider?.dispose();
        sessionUser?.shutdown();
      } catch {
        /* session already closed */
      }
      const err = describeError(e);
      if (err.login) {
        // Ask again right here instead of sending the user to the settings.
        setLogin({ username: typed.current?.username ?? loginUser, password: '', remember: true, error: err.text, mode });
        props.onStatus('disconnected', err.text);
      } else if (!stoppedTransferReason && !retry(err.text)) props.onStatus('disconnected', err.text);
    });

    return () => {
      cancelled = true;
      sessionAlive = false;
      downloadLifecycle.current.end(generation);
      downloadAction.current = null;
      stopStallWatch();
      if (activeNativeId) void rdpDownload.cancel(activeNativeId).catch(() => {});
      window.clearInterval(retryTimer);
      window.clearInterval(idleTimer);
      try {
        sessionUser?.shutdown();
      } catch {
        /* already closed */
      }
      try {
        transferProvider?.dispose();
      } catch {
        /* already closed */
      }
      if (ui.current === sessionUser) ui.current = null;
      frame?.remove();
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

  const focus = () => {
    const f = host.current?.querySelector('iframe');
    f?.focus();
    (f?.contentDocument?.querySelector('iron-remote-desktop') as HTMLElement | null)?.focus();
  };
  useEffect(() => {
    if (props.active && status === 'connected') requestAnimationFrame(focus);
  }, [props.active, status]);

  useEffect(() => {
    webRdpSessions.set(props.id, {
      reconnect: () => setAttempt((n) => n + 1),
      disconnect: () => {
        userEnded.current = true;
        ui.current?.shutdown();
      },
      ctrlAltDel: () => ui.current?.ctrlAltDel(),
      focus,
      thumb: () => {
        try {
          const doc = host.current?.querySelector('iframe')?.contentDocument;
          const comp = doc?.querySelector('iron-remote-desktop');
          const src = (comp?.shadowRoot?.querySelector('canvas') ?? doc?.querySelector('canvas')) as HTMLCanvasElement | null;
          if (!src || !src.width || !src.height) return '';
          const out = document.createElement('canvas');
          out.width = 420;
          out.height = Math.round((src.height * 420) / src.width);
          out.getContext('2d')?.drawImage(src, 0, 0, out.width, out.height);
          return out.toDataURL('image/jpeg', 0.78);
        } catch {
          return '';
        }
      },
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
      {status === 'connected' && (
        <div className="rdp-files-tools">
          <button className="btn" type="button" onClick={() => setFilesOpen((open) => !open)}>
            Remote files{availableFiles.length > 0 ? ` (${availableFiles.filter((file) => !file.info.isDirectory).length})` : ''}
          </button>
          {filesOpen && (
            <section className="rdp-files-panel" aria-label="Files copied from remote computer">
              <header className="rdp-files-head">
                <div>
                  <strong>Copied from remote PC</strong>
                  <div className="hint">Select a file on the remote desktop, copy it, then save it here.</div>
                </div>
                <button className="icon-btn sm" type="button" aria-label="Close remote files" onClick={() => setFilesOpen(false)}>×</button>
              </header>
              {!clipboardEnabled ? (
                <div className="rdp-files-empty">Clipboard redirection is disabled. Enable it in Remote Desktop settings and reconnect.</div>
              ) : availableFiles.length === 0 ? (
                <div className="rdp-files-empty">Copy one or more files on the remote desktop to see them here.</div>
              ) : (
                <div className="rdp-files-list">
                  {availableFiles.map((file) => {
                    const key = remoteFileKey(file);
                    const transfer = transferUi[key];
                    const directory = !!file.info.isDirectory;
                    const tooLarge = file.info.size > MAX_NATIVE_DOWNLOAD_BYTES;
                    return (
                      <div className="rdp-file-row" key={key}>
                        <div className="rdp-file-main">
                          <div className="rdp-file-name" title={file.info.path ? `${file.info.path}/${file.info.name}` : file.info.name}>
                            {file.info.path ? `${file.info.path.replaceAll('\\', '/')}/` : ''}{file.info.name}
                          </div>
                          <div className="rdp-file-meta">
                            {directory ? 'Folder' : formatBytes(file.info.size)}
                            {transfer?.state === 'downloading' ? ` · ${Math.round(transfer.progress)}%` : ''}
                            {transfer?.state === 'writing' ? ' · Saving…' : ''}
                            {transfer?.state === 'saving' ? ' · Choose a save location…' : ''}
                            {transfer?.state === 'done' ? ' · Saved' : ''}
                            {tooLarge ? ` · Over ${formatBytes(MAX_NATIVE_DOWNLOAD_BYTES)} limit` : ''}
                          </div>
                          {transfer?.state === 'downloading' && <progress className="rdp-file-progress" max="100" value={transfer.progress} />}
                          {transfer?.state === 'error' && <div className="rdp-file-error">{transfer.error}</div>}
                        </div>
                        <button className="btn sm" type="button" disabled={downloading || directory || tooLarge || transfer?.state === 'saving' || transfer?.state === 'downloading' || transfer?.state === 'writing' || !clipboardEnabled} onClick={() => downloadAction.current?.(file)}>
                          Save
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {clipboardWarning && <div className="rdp-files-warning">{clipboardWarning}</div>}
              <footer className="rdp-files-foot">Individual files only · 256 MiB maximum · folder entries are listed but cannot be saved as a whole folder</footer>
            </section>
          )}
        </div>
      )}
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
                <div className="rdp-card-title">{status === 'reconnecting' ? 'Reconnecting to' : 'Connecting to'} {props.pane.title}…</div>
                <div className="rdp-card-text">{status === 'reconnecting' && props.pane.message ? props.pane.message : props.pane.subtitle}</div>
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}
