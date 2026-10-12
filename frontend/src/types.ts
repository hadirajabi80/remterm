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
  | { kind: 'local'; shellId: string; cwd?: string };

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
