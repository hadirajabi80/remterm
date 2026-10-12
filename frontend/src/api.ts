import type { CmdEntry } from './history';
import type { Host, LocalShell, Snippet } from './types';

// Wails injects window.go (bound Go methods) and window.runtime at load.
declare global {
  interface Window {
    go: { main: { App: Record<string, (...args: any[]) => Promise<any>> } };
    runtime: {
      EventsOn(name: string, cb: (...data: any[]) => void): () => void;
      ClipboardGetText(): Promise<string>;
      ClipboardSetText(text: string): Promise<boolean>;
      BrowserOpenURL(url: string): void;
    };
  }
}

const call = <T>(method: string, ...args: unknown[]): Promise<T> => window.go.main.App[method](...args);

export interface ConnectRequest {
  sessionId: string;
  hostId: string;
  spec: string;
  password: string;
  savePassword: boolean;
  cols: number;
  rows: number;
}

export interface ConnectResult {
  hostId: string;
  saved: boolean;
}

export const api = {
  listHosts: () => call<Host[] | null>('ListHosts').then((r) => r ?? []),
  saveHost: (h: Host, secret: string) => call<Host>('SaveHost', h, secret),
  deleteHost: (id: string) => call<void>('DeleteHost', id),
  clearSecret: (id: string) => call<void>('ClearSecret', id),
  pickKeyFile: () => call<string>('PickKeyFile'),
  importSSHConfig: () => call<number>('ImportSSHConfig'),
  listSnippets: () => call<Snippet[] | null>('ListSnippets').then((r) => r ?? []),
  saveSnippet: (s: Snippet) => call<Snippet>('SaveSnippet', s),
  deleteSnippet: (id: string) => call<void>('DeleteSnippet', id),
  connect: (req: ConnectRequest) => call<ConnectResult | null>('Connect', req),
  write: (id: string, data: string) => call<void>('Write', id, data),
  resize: (id: string, cols: number, rows: number) => call<void>('Resize', id, cols, rows),
  disconnect: (id: string) => call<void>('Disconnect', id),
  listShells: () => call<LocalShell[] | null>('ListShells').then((r) => r ?? []),
  openLocal: (req: { sessionId: string; shellId: string; cwd?: string; cols: number; rows: number }) => call<void>('OpenLocal', req),
  takeLaunchFolder: () => call<string>('TakeLaunchFolder'),
  explorerMenuEnabled: () => call<boolean>('ExplorerMenuEnabled'),
  setExplorerMenu: (enable: boolean) => call<void>('SetExplorerMenu', enable),
  getSettings: () => call<string>('GetSettings'),
  saveSettings: (json: string) => call<void>('SaveSettings', json),
  listCommandHistory: () => call<CmdEntry[] | null>('ListCommandHistory').then((r) => r ?? []),
  addCommandHistory: (command: string, hostKey: string) => call<void>('AddCommandHistory', command, hostKey),
  deleteCommandHistory: (command: string) => call<void>('DeleteCommandHistory', command),
  clearCommandHistory: () => call<void>('ClearCommandHistory'),
};

export interface SessionHandlers {
  data(bytes: Uint8Array): void;
  /** exitCode: process exit status, -1 when unknown (dropped, disconnected). */
  closed(reason: string, lost: boolean, exitCode: number): void;
  latency(ms: number): void;
}

// One global listener per event, dispatched by session id.
const handlers = new Map<string, SessionHandlers>();
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  window.runtime.EventsOn('term:data', (id: string, b64: string) => handlers.get(id)?.data(decodeBase64(b64)));
  window.runtime.EventsOn('term:closed', (id: string, reason: string, lost: boolean, exitCode?: number) =>
    handlers.get(id)?.closed(reason, lost, exitCode ?? -1),
  );
  window.runtime.EventsOn('term:latency', (id: string, ms: number) => handlers.get(id)?.latency(ms));
}

export function registerSession(id: string, h: SessionHandlers): () => void {
  wire();
  handlers.set(id, h);
  return () => {
    handlers.delete(id);
  };
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const clipboard = {
  read: () => window.runtime.ClipboardGetText().catch(() => ''),
  write: (text: string) => window.runtime.ClipboardSetText(text).catch(() => false),
};

export const openURL = (url: string) => window.runtime.BrowserOpenURL(url);

/** Another launch of Termora (e.g. Explorer "Open in Termora") asked to open a folder. */
export const onLaunchOpen = (cb: (folder: string) => void) => window.runtime.EventsOn('launch:open', cb);

export function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function cleanError(msg: string): string {
  return msg.replace(/^(AUTH_FAILED|PASSPHRASE_REQUIRED):\s*/, '');
}
