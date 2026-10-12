import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { api, cleanError, clipboard, errorMessage, openURL, registerSession, type ConnectResult } from './api';
import { LineTracker, type CursorAnchor } from './autocomplete';
import type { PaneTarget, TabStatus } from './types';

export type AuthKind = 'password' | 'passphrase';

export interface SessionEvents {
  status(status: TabStatus, patch?: { latency?: number; message?: string }): void;
  dims(cols: number, rows: number): void;
  auth(kind: AuthKind, message: string): Promise<{ password: string; save: boolean } | null>;
  /** SSH login succeeded; hostId is the saved host the session belongs to (new if saved). */
  linked(result: ConnectResult): void;
  /** The shell ended on its own with exit code 0 (user typed `exit`). */
  exited(): void;
  /** Keyboard input; return true when handled elsewhere (broadcast to several panes). */
  input(data: string): boolean;
  /** The terminal got focus (user clicked into it). */
  focused(): void;
  /** ↑ at a prompt: show the history list with the typed text as filter. */
  historyList(query: string, anchor: CursorAnchor | null): void;
  /** First output since the user last looked at this pane. */
  output(): void;
}

export interface TermOptions {
  fontSize: number;
  theme: ITheme;
}

const MAX_RETRIES = 6;

/**
 * One terminal pane: owns the xterm instance and its session (SSH or local
 * shell), and handles reconnects, auth prompts, clipboard and ordered input.
 */
export class TermSession {
  readonly term: Terminal;
  readonly search = new SearchAddon();
  private readonly fitAddon = new FitAddon();
  private el?: HTMLElement;
  private sessionId: string | null = null;
  private unregister?: () => void;
  private connected = false;
  private disposed = false;
  private state: TabStatus = 'connecting';
  private retries = 0;
  private retryTimer?: number;
  private password = '';
  private pending = '';
  private flushing = false;
  private latency?: number;
  private readonly tracker: LineTracker;
  private watching = true;
  private signaledOutput = false;
  private runQueue: string[] = [];

  constructor(
    private target: PaneTarget,
    private readonly events: SessionEvents,
    opts: TermOptions,
  ) {
    this.term = new Terminal({
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: opts.fontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 20000,
      allowProposedApi: true,
      allowTransparency: true,
      smoothScrollDuration: 0,
      theme: opts.theme,
    });
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon((_e, uri) => openURL(uri)));

    this.term.onData((d) => this.onInput(d));
    this.term.onResize(({ cols, rows }) => {
      this.events.dims(cols, rows);
      if (this.connected && this.sessionId) api.resize(this.sessionId, cols, rows).catch(() => {});
    });
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));
    this.tracker = new LineTracker(this.term, () => this.historyKey, (d) => this.send(d));
  }

  get isLocal() {
    return this.target.kind === 'local';
  }

  /** Identifies where commands ran, for history. */
  get historyKey(): string {
    const t = this.target;
    if (t.kind === 'local') return `local:${t.shellId}`;
    if (t.kind !== 'ssh') return t.kind;
    return t.hostId ? `ssh:${t.hostId}` : `spec:${t.spec}`;
  }

  /** Whether the user can see this pane; unseen output raises events.output once. */
  setWatching(watching: boolean) {
    this.watching = watching;
    if (watching) this.signaledOutput = false;
  }

  /** Sends text as soon as the session is connected (multi-host snippet runs). */
  runWhenConnected(text: string) {
    if (this.connected) this.send(text);
    else this.runQueue.push(text);
  }

  /** Replaces the current prompt line with a command from history. */
  useHistory(command: string, run: boolean) {
    if (this.connected) this.tracker.replaceLine(command, run);
    this.focus();
  }

  /** Where a duplicate of this pane should connect. */
  get currentTarget(): PaneTarget {
    return this.target;
  }

  attach(el: HTMLElement) {
    if (this.el === el) return;
    if (this.el) {
      // The pane moved (tab dragged into another tab's split): move the live terminal along.
      this.el = el;
      if (this.term.element) el.appendChild(this.term.element);
      requestAnimationFrame(() => this.fit());
      return;
    }
    this.el = el;
    this.term.open(el);
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      this.term.loadAddon(gl);
    } catch {
      /* canvas/DOM renderer fallback */
    }
    this.term.textarea?.addEventListener('focus', () => this.events.focused());
    // Right-click: copy when there is a selection, otherwise paste.
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.term.hasSelection()) this.copySelection();
      else this.paste();
    });
    this.fit();
    this.events.dims(this.term.cols, this.term.rows);
    void this.connect();
  }

  fit() {
    if (!this.el || this.el.offsetParent === null) return;
    try {
      this.fitAddon.fit();
    } catch {
      /* not measurable yet */
    }
  }

  focus() {
    this.term.focus();
  }

  setOptions(opts: TermOptions) {
    this.term.options.theme = opts.theme;
    if (this.term.options.fontSize !== opts.fontSize) {
      this.term.options.fontSize = opts.fontSize;
      this.fit();
    }
  }

  /** Sends text to the shell. Returns false if not connected. */
  send(text: string): boolean {
    if (!this.connected || !this.sessionId) return false;
    this.tracker.onSend(text);
    this.pending += text;
    if (!this.flushing) void this.flush();
    return true;
  }

  reconnect() {
    this.retries = 0;
    const old = this.sessionId;
    this.sessionId = null; // ignore the close event of the old session
    if (old) api.disconnect(old).catch(() => {});
    void this.connect();
  }

  dispose() {
    this.disposed = true;
    window.clearTimeout(this.retryTimer);
    if (this.sessionId) api.disconnect(this.sessionId).catch(() => {});
    this.unregister?.();
    this.term.dispose();
  }

  // ---- connection lifecycle ----

  private async connect(password?: string, save = false): Promise<void> {
    if (this.disposed) return;
    window.clearTimeout(this.retryTimer);
    this.unregister?.();
    if (password !== undefined) this.password = password;

    const id = crypto.randomUUID();
    const wasReconnecting = this.state === 'reconnecting';
    this.sessionId = id;
    this.connected = false;
    this.setState(wasReconnecting ? 'reconnecting' : 'connecting');

    this.unregister = registerSession(id, {
      data: (b) => {
        this.term.write(b);
        if (!this.watching && !this.signaledOutput) {
          this.signaledOutput = true;
          this.events.output();
        }
      },
      closed: (reason, lost, exitCode) => this.onClosed(id, reason, lost, exitCode),
      latency: (ms) => {
        if (this.sessionId !== id) return;
        this.latency = ms;
        if (this.connected) this.events.status('connected', { latency: ms });
      },
    });

    let result: ConnectResult | null = null;
    try {
      const t = this.target;
      if (t.kind === 'sftp' || t.kind === 'log' || t.kind === 'rdp') throw new Error('not a terminal');
      if (t.kind === 'local') {
        await api.openLocal({
          sessionId: id,
          shellId: t.shellId,
          cwd: t.cwd,
          cols: this.term.cols,
          rows: this.term.rows,
        });
      } else {
        result = await api.connect({
          sessionId: id,
          hostId: t.hostId ?? '',
          spec: t.spec ?? '',
          password: this.password,
          savePassword: save,
          cols: this.term.cols,
          rows: this.term.rows,
        });
      }
    } catch (e) {
      if (this.sessionId !== id || this.disposed) return;
      this.unregister?.();
      this.unregister = undefined;
      this.sessionId = null;

      const msg = errorMessage(e);
      const kind: AuthKind | null = msg.startsWith('PASSPHRASE_REQUIRED')
        ? 'passphrase'
        : msg.startsWith('AUTH_FAILED')
          ? 'password'
          : null;
      if (kind) {
        this.setState('connecting', 'Waiting for credentials');
        const res = await this.events.auth(kind, this.password ? cleanError(msg) : '');
        if (res) return this.connect(res.password, res.save);
        return this.fail('Authentication cancelled');
      }
      if (wasReconnecting) return this.scheduleRetry(cleanError(msg));
      return this.fail(cleanError(msg));
    }

    if (this.sessionId !== id || this.disposed) return;
    if (this.retries > 0) this.notice('Reconnected', 32);
    this.connected = true;
    this.retries = 0;
    this.state = 'connected';
    this.events.status('connected', { latency: this.latency, message: undefined });
    if (result) {
      // Quick-connect panes reconnect through the saved host from now on.
      if (result.hostId) this.target = { kind: 'ssh', hostId: result.hostId };
      this.events.linked(result);
    }
    // Size may have changed while we were connecting.
    api.resize(id, this.term.cols, this.term.rows).catch(() => {});
    if (this.runQueue.length) {
      const queued = this.runQueue.splice(0);
      // Give the shell a moment to print its prompt first.
      window.setTimeout(() => queued.forEach((q) => this.send(q)), 800);
    }
  }

  private onClosed(id: string, reason: string, lost: boolean, exitCode: number) {
    if (id !== this.sessionId || this.disposed) return;
    this.connected = false;
    this.pending = '';
    this.tracker.reset();
    if (exitCode === 0) {
      this.setState('disconnected', reason);
      this.events.exited();
      return;
    }
    if (lost) this.scheduleRetry(reason);
    else this.fail(reason);
  }

  private scheduleRetry(reason: string) {
    if (this.retries >= MAX_RETRIES) {
      this.fail(`${reason} — gave up after ${MAX_RETRIES} attempts`);
      return;
    }
    this.retries++;
    const delay = Math.min(30, 2 ** (this.retries - 1));
    this.notice(`${reason}. Reconnecting in ${delay}s (attempt ${this.retries}/${MAX_RETRIES})`, 33, 'Enter = retry now');
    this.setState('reconnecting', reason);
    this.retryTimer = window.setTimeout(() => void this.connect(), delay * 1000);
  }

  private fail(reason: string) {
    this.retries = 0;
    this.notice(reason, 31, this.isLocal ? 'Press Enter to restart' : 'Press Enter to reconnect');
    this.setState('disconnected', reason);
  }

  private setState(state: TabStatus, message?: string) {
    this.state = state;
    this.events.status(state, { message });
  }

  private notice(text: string, color: number, hint?: string) {
    const lines = text.split('\n').join('\r\n  ');
    this.term.write(`\r\n\x1b[${color}m● ${lines}\x1b[0m${hint ? `  \x1b[90m${hint}\x1b[0m` : ''}\r\n`);
  }

  // ---- input ----

  private onInput(d: string) {
    if (this.connected) {
      if (!this.events.input(d)) this.send(d);
      return;
    }
    if (d === '\r' && (this.state === 'disconnected' || this.state === 'reconnecting')) {
      this.retries = 0;
      void this.connect();
    }
  }

  /** Wails dispatches calls concurrently, so writes are serialized here to keep keystroke order. */
  private async flush() {
    this.flushing = true;
    while (this.pending && this.sessionId && this.connected) {
      const chunk = this.pending;
      this.pending = '';
      try {
        await api.write(this.sessionId, chunk);
      } catch {
        break;
      }
    }
    this.flushing = false;
  }

  private onKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
    // History: ↑ opens the list, → / Ctrl+→ accept the gray suggestion.
    if (plain && e.key === 'ArrowUp' && this.connected && this.tracker.canOpenHistory()) {
      e.preventDefault();
      this.events.historyList(this.tracker.buffer, this.tracker.cursorAnchor());
      return false;
    }
    if (e.key === 'ArrowRight' && (plain || (ctrl && !e.shiftKey)) && this.tracker.accept(ctrl)) {
      e.preventDefault();
      return false;
    }    if (ctrl && e.shiftKey && e.code === 'KeyC') {
      this.copySelection();
      return false;
    }
    if (ctrl && !e.shiftKey && e.code === 'KeyC' && this.term.hasSelection()) {
      this.copySelection();
      return false;
    }
    if (ctrl && e.code === 'KeyV') {
      e.preventDefault();
      this.paste();
      return false;
    }
    return true;
  }

  private copySelection() {
    const sel = this.term.getSelection();
    if (sel) void clipboard.write(sel);
    this.term.clearSelection();
  }

  private paste() {
    void clipboard.read().then((text) => {
      if (text) this.term.paste(text);
    });
  }
}
