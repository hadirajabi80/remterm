import type { CmdEntry } from './history';
import type {
  FileEntry,
  GroupConfig,
  Host,
  Identity,
  KeyItem,
  KnownHost,
  LocalShell,
  LogEntry,
  Snippet,
  TransferProgress,
  Tunnel,
  TunnelStatus,
  Workspace,
} from './types';

// Wails injects window.go (bound Go methods) and window.runtime at load.
declare global {
  interface Window {
    go: { main: { App: Record<string, (...args: any[]) => Promise<any>> } };
    runtime: {
      EventsOn(name: string, cb: (...data: any[]) => void): () => void;
      ClipboardGetText(): Promise<string>;
      ClipboardSetText(text: string): Promise<boolean>;
      BrowserOpenURL(url: string): void;
      OnFileDrop?(cb: (x: number, y: number, paths: string[]) => void, useDropTarget: boolean): void;
      OnFileDropOff?(): void;
    };
  }
}

const call = <T>(method: string, ...args: unknown[]): Promise<T> => window.go.main.App[method](...args);

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  newer?: boolean; // a newer release exists, even if its file for this system is not attached yet
  notes: string;
  page: string;
  asset: string;
  url: string;
  size: number;
}

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
  saveHost: (h: Host, secret: string, proxyPassword = '') => call<Host>('SaveHost', h, secret, proxyPassword),
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
  platform: () => call<string>('Platform'),
  setWindowTheme: (theme: 'dark' | 'light') => call<void>('SetWindowTheme', theme),
  appVersion: () => call<string>('AppVersion'),
  checkUpdate: () => call<UpdateInfo>('CheckUpdate'),
  installUpdate: () => call<void>('InstallUpdate'),
  explorerMenuEnabled: () => call<boolean>('ExplorerMenuEnabled'),
  setExplorerMenu: (enable: boolean) => call<void>('SetExplorerMenu', enable),
  classicMenu: () => call<{ supported: boolean; enabled: boolean }>('ClassicMenu'),
  setClassicMenu: (enable: boolean) => call<void>('SetClassicMenu', enable),
  restartExplorer: () => call<void>('RestartExplorer'),
  getSettings: () => call<string>('GetSettings'),
  saveSettings: (json: string) => call<void>('SaveSettings', json),
  listCommandHistory: () => call<CmdEntry[] | null>('ListCommandHistory').then((r) => r ?? []),
  addCommandHistory: (command: string, hostKey: string) => call<void>('AddCommandHistory', command, hostKey),
  deleteCommandHistory: (command: string) => call<void>('DeleteCommandHistory', command),
  clearCommandHistory: () => call<void>('ClearCommandHistory'),

  // groups & identities
  listGroups: () => call<GroupConfig[] | null>('ListGroups').then((r) => r ?? []),
  saveGroup: (g: GroupConfig, proxyPassword = '') => call<GroupConfig>('SaveGroup', g, proxyPassword),
  renameGroup: (from: string, to: string) => call<void>('RenameGroup', from, to),
  deleteGroup: (path: string) => call<void>('DeleteGroup', path),
  listIdentities: () => call<Identity[] | null>('ListIdentities').then((r) => r ?? []),
  saveIdentity: (i: Identity, password: string) => call<Identity>('SaveIdentity', i, password),
  clearIdentityPassword: (id: string) => call<void>('ClearIdentityPassword', id),
  deleteIdentity: (id: string) => call<void>('DeleteIdentity', id),

  // keychain
  listKeys: () => call<KeyItem[] | null>('ListKeys').then((r) => r ?? []),
  generateKey: (req: { label: string; type: string; bits: number; passphrase: string; savePassphrase: boolean }) =>
    call<KeyItem>('GenerateKey', req),
  importKey: (req: { label: string; privateKey: string; path: string; passphrase: string; savePassphrase: boolean }) =>
    call<KeyItem>('ImportKey', req),
  updateKey: (id: string, label: string, certificate: string) => call<KeyItem>('UpdateKey', id, label, certificate),
  setKeyPassphrase: (id: string, passphrase: string) => call<void>('SetKeyPassphrase', id, passphrase),
  deleteKey: (id: string) => call<void>('DeleteKey', id),
  exportKeyToHost: (req: { keyId: string; hostId: string; password: string; path: string }) => call<void>('ExportKeyToHost', req),

  // port forwarding
  listTunnels: () => call<Tunnel[] | null>('ListTunnels').then((r) => r ?? []),
  saveTunnel: (t: Tunnel) => call<Tunnel>('SaveTunnel', t),
  deleteTunnel: (id: string) => call<void>('DeleteTunnel', id),
  startTunnel: (id: string, password = '') => call<void>('StartTunnel', id, password),
  stopTunnel: (id: string) => call<void>('StopTunnel', id),
  tunnelStatuses: () => call<TunnelStatus[] | null>('TunnelStatuses').then((r) => r ?? []),

  // workspaces, logs, known hosts, imports
  listWorkspaces: () => call<Workspace[] | null>('ListWorkspaces').then((r) => r ?? []),
  saveWorkspace: (w: Workspace) => call<Workspace>('SaveWorkspace', w),
  deleteWorkspace: (id: string) => call<void>('DeleteWorkspace', id),
  listLogs: () => call<LogEntry[] | null>('ListLogs').then((r) => r ?? []),
  readLog: (id: string) => call<string>('ReadLog', id),
  setLogBookmark: (id: string, bookmarked: boolean, comment: string) => call<void>('SetLogBookmark', id, bookmarked, comment),
  deleteLog: (id: string) => call<void>('DeleteLog', id),
  exportLog: (id: string) => call<string>('ExportLog', id),
  setLogging: (enabled: boolean) => call<void>('SetLogging', enabled),
  listKnownHosts: () => call<KnownHost[] | null>('ListKnownHosts').then((r) => r ?? []),
  removeKnownHost: (line: number) => call<void>('RemoveKnownHost', line),
  listSerialPorts: () => call<string[] | null>('ListSerialPorts').then((r) => r ?? []),
  importPuTTY: () => call<number>('ImportPuTTY'),

  // files (SFTP + local disk; fsId 'local' is the local disk)
  openSftp: (req: { sessionId: string; hostId: string; password: string; savePassword: boolean }) => call<string>('OpenSftp', req),
  closeSftp: (id: string) => call<void>('CloseSftp', id),
  fsHome: (fsId: string) => call<string>('FsHome', fsId),
  fsList: (fsId: string, dir: string) => call<FileEntry[] | null>('FsList', fsId, dir).then((r) => r ?? []),
  fsParent: (fsId: string, path: string) => call<string>('FsParent', fsId, path),
  fsMkdir: (fsId: string, path: string) => call<void>('FsMkdir', fsId, path),
  fsRename: (fsId: string, from: string, to: string) => call<void>('FsRename', fsId, from, to),
  fsDelete: (fsId: string, paths: string[]) => call<void>('FsDelete', fsId, paths),
  fsChmod: (fsId: string, path: string, perm: number) => call<void>('FsChmod', fsId, path, perm),
  fsTransfer: (req: { srcFs: string; paths: string[]; dstFs: string; dstDir: string }) => call<string>('FsTransfer', req),
  cancelTransfer: (id: string) => call<void>('CancelTransfer', id),
  fsOpen: (fsId: string, path: string) => call<void>('FsOpen', fsId, path),
};

export const events = {
  on: (name: string, cb: (...data: any[]) => void) => window.runtime.EventsOn(name, cb),
  tunnelStatus: (cb: (s: TunnelStatus) => void) => window.runtime.EventsOn('tunnel:status', cb),
  transfer: (cb: (p: TransferProgress) => void) => window.runtime.EventsOn('fs:transfer', cb),
  fsEdited: (cb: (fsId: string, path: string, error: string) => void) => window.runtime.EventsOn('fs:edited', cb),
  fsClosed: (cb: (fsId: string) => void) => window.runtime.EventsOn('fs:closed', cb),
  /** Files dropped from Explorer onto the window (x, y in CSS pixels). */
  fileDrop: (cb: (x: number, y: number, paths: string[]) => void) => {
    window.runtime.OnFileDrop?.(cb, false);
    return () => window.runtime.OnFileDropOff?.();
  },
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

/** Another launch of Remterm (e.g. Explorer "Open in Remterm") asked to open a folder. */
export const onLaunchOpen = (cb: (folder: string) => void) => window.runtime.EventsOn('launch:open', cb);

export function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function cleanError(msg: string): string {
  return msg.replace(/^(AUTH_FAILED|PASSPHRASE_REQUIRED):\s*/, '');
}
