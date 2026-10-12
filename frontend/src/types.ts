export interface Host {
  id: string;
  name: string;
  group: string;
  env: string; // '', 'dev', 'staging', 'prod'
  address: string;
  port: number;
  user: string;
  authMethod: string; // 'auto' | 'key' | 'password'
  keyPath: string;
  jumpHostId: string;
  startupCommand: string;
  hasSecret: boolean;
  lastUsed: number; // unix ms, 0 = never
  protocol: string; // '' | 'ssh' | 'telnet' | 'serial'
  tags: string[] | null;
  keyId: string;
  identityId: string;
  agentForwarding: boolean;
  envVars: EnvVar[] | null;
  proxy?: Proxy | null;
  scheme: string;
  serial?: SerialConfig | null;
}

export interface EnvVar {
  name: string;
  value: string;
}

export interface Proxy {
  type: 'socks5' | 'http';
  host: string;
  port: number;
  user: string;
  hasSecret: boolean;
}

export interface SerialConfig {
  port: string;
  baud: number;
  dataBits: number;
  stopBits: string;
  parity: string;
  flowControl: string;
}

/** Defaults for every host in a group ("A/B/C" paths) and its subgroups. */
export interface GroupConfig {
  path: string;
  identityId: string;
  jumpHostId: string;
  startupCommand: string;
  envVars: EnvVar[] | null;
  proxy?: Proxy | null;
  agentForwarding: boolean;
  scheme: string;
}

export interface Identity {
  id: string;
  label: string;
  username: string;
  keyId: string;
  hasPassword: boolean;
}

export interface KeyItem {
  id: string;
  label: string;
  type: string;
  publicKey: string;
  fingerprint: string;
  encrypted: boolean;
  hasPassphrase: boolean;
  certificate: string;
  created: number;
}

export interface Tunnel {
  id: string;
  label: string;
  type: 'local' | 'remote' | 'dynamic';
  hostId: string;
  bindAddress: string;
  port: number;
  destHost: string;
  destPort: number;
  autoStart: boolean;
}

export interface TunnelStatus {
  id: string;
  state: 'stopped' | 'starting' | 'running' | 'error';
  error: string;
  conns: number;
}

export interface WorkspaceData {
  layout: Layout;
  targets: Record<string, PaneTarget>;
  activePane: string;
  broadcast: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  data: WorkspaceData;
}

export interface LogEntry {
  id: string;
  hostKey: string;
  title: string;
  started: number;
  ended: number;
  size: number;
  bookmarked: boolean;
  comment: string;
}

export interface KnownHost {
  line: number;
  hosts: string;
  keyType: string;
  fingerprint: string;
  marker: string;
}

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  link: boolean;
  size: number;
  mode: string;
  perm: number;
  modified: number;
}

export interface TransferProgress {
  id: string;
  state: 'running' | 'done' | 'error' | 'canceled';
  label: string;
  file: string;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  error: string;
}

export interface Snippet {
  id: string;
  name: string;
  group: string;
  command: string; // may contain {{name}} / {{name:default}} placeholders
  description: string;
}

export interface LocalShell {
  id: string; // 'pwsh' | 'powershell' | 'cmd' | 'wsl' | 'gitbash'
  name: string;
  command: string;
}

export type TabStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** What a pane is connected to. */
export type PaneTarget =
  | { kind: 'ssh'; hostId?: string; spec?: string }
  | { kind: 'local'; shellId: string; cwd?: string }
  | { kind: 'sftp'; hostId: string }
  | { kind: 'log'; logId: string; title: string };

/** One terminal inside a tab. */
export interface Pane {
  key: string;
  target: PaneTarget;
  title: string;
  subtitle: string;
  env: string;
  status: TabStatus;
  message?: string;
  latency?: number;
  cols?: number;
  rows?: number;
  unread?: boolean; // output arrived while not looking
}

/** Binary split tree: 'row' = side by side, 'col' = stacked. ratio is the first child's share. */
export type Layout =
  | { type: 'pane'; key: string }
  | { type: 'split'; key: string; dir: 'row' | 'col'; ratio: number; a: Layout; b: Layout };

export interface Tab {
  key: string;
  layout: Layout;
  activePane: string;
  zoomed: boolean; // active pane fills the tab
  broadcast: boolean; // keystrokes go to every pane of the tab
}

export interface Appearance {
  scheme: string;
  background: string; // preset id, 'custom' or 'none'
  customImage: string; // data URL when background === 'custom'
  dim: number; // 0–95, % darkening over the background
  blur: number; // px
  fontSize: number;
}
