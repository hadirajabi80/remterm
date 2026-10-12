import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, cleanError, errorMessage, events, onLaunchOpen, openURL } from './api';
import type { CursorAnchor } from './autocomplete';
import { history, typingPrefs } from './history';
import { gridLayout, leaves, neighbor, remapLayout, removePane, setRatio, splitPane, type Direction } from './layout';
import { TermSession, type AuthKind, type TermOptions } from './terminal';
import { DEFAULT_APPEARANCE, backgroundCss, getScheme } from './themes';
import { transfers } from './transfers';
import { lastUsedMs, machineDetail, onRdpEvent, rdp } from './rdp';
import type {
  Appearance,
  GroupConfig,
  Host,
  Identity,
  KeyItem,
  LocalShell,
  Machine,
  Pane,
  PaneTarget,
  RdpData,
  RdpStatus,
  Snippet,
  Tab,
  TabStatus,
  Tunnel,
  TunnelStatus,
  Workspace,
} from './types';
import { byRecent, hostLabel, hostsInGroup, inherited, snippetVars } from './util';
import { AppearancePanel } from './components/AppearancePanel';
import { CommandPalette, type PaletteItem } from './components/CommandPalette';
import { FindBar } from './components/FindBar';
import { HistoryList } from './components/HistoryList';
import { HostDialog } from './components/HostDialog';
import { LogView } from './components/LogView';
import { AuthDialog, ConfirmDialog } from './components/Modal';
import { PromptDialog } from './components/fields';
import { SftpView } from './components/SftpView';
import { Sidebar, type Panel, type SidebarCtx } from './components/Sidebar';
import { SnippetDialog } from './components/SnippetDialog';
import { SnippetVarsDialog } from './components/SnippetVarsDialog';
import { StatusBar } from './components/StatusBar';
import { TabBar, type TabView } from './components/TabBar';
import { TabPanes } from './components/TabPanes';
import {
  GenerateKeyDialog,
  GroupDialog,
  IdentityDialog,
  ImportKeyDialog,
  KeyDetailsDialog,
  PickHostsDialog,
  TunnelDialog,
} from './components/VaultDialogs';
import { Welcome } from './components/Welcome';
import { RdpView } from './components/RdpView';
import { WebRdpView, webRdpSessions } from './components/WebRdpView';
import type { RdpCtx } from './components/RdpPanel';
import { ImportDialog, LockScreen, LoginsDialog, MachineDialog, RdpSettingsDialog, type RdpSettingsTab } from './components/RdpDialogs';
import { TabDropOverlay, type DropSide, type TabDrag } from './components/TabDrop';

type RdpTarget = Extract<PaneTarget, { kind: 'rdp' }>;

type RdpDialogState =
  | { kind: 'machine'; machine: Machine | null; group?: string }
  | { kind: 'logins' }
  | { kind: 'settings'; tab?: RdpSettingsTab }
  | { kind: 'import' };

const STATUS_RANK: Record<TabStatus, number> = { connected: 3, connecting: 2, reconnecting: 1, disconnected: 0 };
const rdpErrorText = (msg: string) => msg.replace(/^(BASTION|LOCKED|NO_RDP_CLIENT):\s*/, '');

interface AuthRequest {
  kind: AuthKind;
  target: string;
  error: string;
  canSave: boolean;
  resolve(r: { password: string; save: boolean } | null): void;
}

interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  run(): void | Promise<void>;
}

interface PromptRequest {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  run(value: string): void | Promise<void>;
}

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

const EMPTY_GROUP: GroupConfig = { path: '', identityId: '', jumpHostId: '', startupCommand: '', envVars: [], proxy: null, agentForwarding: false, scheme: '' };
const MAX_PANES = 16;

function legacyFontSize(): number {
  try {
    const n = Number(localStorage.getItem('fontSize'));
    return n >= 9 && n <= 32 ? n : DEFAULT_APPEARANCE.fontSize;
  } catch {
    return DEFAULT_APPEARANCE.fontSize;
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const newKey = () => crypto.randomUUID();
const isTerminal = (t: PaneTarget) => t.kind === 'ssh' || t.kind === 'local';

export default function App() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [groups, setGroups] = useState<GroupConfig[]>([]);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [tunnelStatus, setTunnelStatus] = useState<Record<string, TunnelStatus>>({});
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [shells, setShells] = useState<LocalShell[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [panes, setPanes] = useState<Record<string, Pane>>({});
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('hosts');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [editingHost, setEditingHost] = useState<{ host: Host | null; group?: string } | null>(null);
  const [editingGroup, setEditingGroup] = useState<{ group: GroupConfig; isNew: boolean } | null>(null);
  const [editingIdentity, setEditingIdentity] = useState<Identity | null | undefined>(undefined);
  const [keyDialog, setKeyDialog] = useState<'generate' | 'import' | KeyItem | null>(null);
  const [editingTunnel, setEditingTunnel] = useState<Tunnel | null | undefined>(undefined);
  const [pickHosts, setPickHosts] = useState<Snippet | null>(null);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [auth, setAuth] = useState<AuthRequest | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [varsRequest, setVarsRequest] = useState<{ snippet: Snippet; execute: boolean; hostIds?: string[] } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [typing, setTyping] = useState({ ...typingPrefs });
  const [historyList, setHistoryList] = useState<{ paneKey: string; query: string; anchor: CursorAnchor | null } | null>(null);
  const [rdpAvailable, setRdpAvailable] = useState(false);
  const [rdpStatus, setRdpStatus] = useState<RdpStatus | null>(null);
  const [rdpData, setRdpData] = useState<RdpData | null>(null);
  const [rdpError, setRdpError] = useState('');
  const [rdpDialog, setRdpDialog] = useState<RdpDialogState | null>(null);
  const appLocked = !!rdpStatus?.locked && !rdpStatus.needsPassword;

  const sessions = useRef(new Map<string, TermSession>());
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const rdpDataRef = useRef(rdpData);
  rdpDataRef.current = rdpData;
  // Latest state for callbacks fired from terminal sessions.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const shellsRef = useRef(shells);
  shellsRef.current = shells;
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;

  const activeTab = tabs.find((t) => t.key === activeKey);
  const activePane = activeTab ? panes[activeTab.activePane] : undefined;
  const activeSession = activeTab ? sessions.current.get(activeTab.activePane) : undefined;
  const activePaneCount = activeTab ? leaves(activeTab.layout).length : 0;
  const overlayOpen = !!(
    editingHost ||
    editingGroup ||
    editingIdentity !== undefined ||
    keyDialog ||
    editingTunnel !== undefined ||
    pickHosts ||
    editingSnippet !== undefined ||
    confirm ||
    prompt ||
    auth ||
    paletteOpen ||
    varsRequest ||
    historyList ||
    rdpDialog ||
    appLocked
  );

  const notify = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    setToast({ id: Date.now(), text, kind });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), toast.kind === 'error' ? 6000 : 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const refresh = useCallback(async () => {
    const [h, s, g, i, k, t, w] = await Promise.all([
      api.listHosts(),
      api.listSnippets(),
      api.listGroups(),
      api.listIdentities(),
      api.listKeys(),
      api.listTunnels(),
      api.listWorkspaces(),
    ]);
    setHosts(h);
    setSnippets(s);
    setGroups(g);
    setIdentities(i);
    setKeys(k);
    setTunnels(t);
    setWorkspaces(w);
  }, []);

  // ---- Remote Desktop: engine status and vault data ----

  const refreshRdp = useCallback(async () => {
    try {
      const st = await rdp.status();
      setRdpStatus(st);
      setRdpError('');
      if (st.ready && !st.locked) setRdpData(await rdp.data());
    } catch (e) {
      setRdpError(rdpErrorText(errorMessage(e)));
    }
  }, []);

  const rdpEventRef = useRef<(name: string, data: any) => void>(() => {});
  useEffect(() => {
    let alive = true;
    const off = onRdpEvent((name, data) => rdpEventRef.current(name, data));
    rdp
      .available()
      .then((ok) => {
        if (!alive) return;
        setRdpAvailable(ok);
        if (ok) void refreshRdp();
      })
      .catch(() => {});
    return () => {
      alive = false;
      off();
    };
  }, [refreshRdp]);

  useEffect(() => {
    refresh().catch((e) => notify(errorMessage(e), 'error'));
    api.listShells().then(setShells).catch(() => {});
    history.load().catch(() => {});
    api
      .tunnelStatuses()
      .then((list) => setTunnelStatus(Object.fromEntries(list.map((s) => [s.id, s]))))
      .catch(() => {});
    const offTunnel = events.tunnelStatus((s) => setTunnelStatus((m) => ({ ...m, [s.id]: s })));
    const offEdited = events.fsEdited((_fs, path, error) =>
      error ? notify(`Upload of ${path} failed: ${error}`, 'error') : notify(`Saved ${path.split('/').pop()} to the server`),
    );
    const offTransfer = events.transfer((p) => {
      if (p.state === 'error') notify(`Transfer failed: ${p.error}`, 'error');
    });
    api
      .getSettings()
      .then((raw) => {
        const saved = raw ? (JSON.parse(raw) as { appearance?: Partial<Appearance>; typing?: Partial<typeof typingPrefs> }) : {};
        setAppearance({ ...DEFAULT_APPEARANCE, fontSize: legacyFontSize(), ...saved.appearance });
        setTyping({ ...typingPrefs, ...saved.typing });
      })
      .catch(() => {})
      .finally(() => setSettingsLoaded(true));
    return () => {
      offTunnel();
      offEdited();
      offTransfer();
    };
  }, [refresh, notify]);

  // ---- appearance (per-host color schemes included) ----

  const optionsFor = useCallback((target: PaneTarget, a: Appearance): TermOptions => {
    let scheme = a.scheme;
    if (target.kind === 'ssh' && target.hostId) {
      const h = hostsRef.current.find((x) => x.id === target.hostId);
      if (h) scheme = inherited(h, groupsRef.current, 'scheme') || scheme;
    }
    const theme = getScheme(scheme).theme;
    // With a background picture the terminal canvas is transparent.
    return { fontSize: a.fontSize, theme: a.background === 'none' ? theme : { ...theme, background: 'rgba(0,0,0,0)' } };
  }, []);

  useEffect(() => {
    sessions.current.forEach((s) => s.setOptions(optionsFor(s.currentTarget, appearance)));
    document.documentElement.style.setProperty('--term-bg', getScheme(appearance.scheme).theme.background);
    if (!settingsLoaded) return;
    const t = window.setTimeout(() => {
      api.saveSettings(JSON.stringify({ appearance, typing })).catch((e) => notify(errorMessage(e), 'error'));
    }, 400);
    return () => window.clearTimeout(t);
  }, [appearance, typing, settingsLoaded, notify, optionsFor, hosts, groups]);

  useEffect(() => {
    Object.assign(typingPrefs, typing);
    void api.setLogging(typing.recordLogs).catch(() => {});
  }, [typing]);

  // ---- panes & tabs ----

  const patchPane = useCallback((key: string, patch: Partial<Pane>) => {
    setPanes((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], ...patch } } : prev));
  }, []);

  const tabOf = (paneKey: string) => tabsRef.current.find((t) => leaves(t.layout).includes(paneKey));

  const focusPane = useCallback((paneKey: string) => {
    const tab = tabsRef.current.find((t) => leaves(t.layout).includes(paneKey));
    if (!tab) return;
    if (tab.activePane !== paneKey) {
      setTabs((prev) => prev.map((t) => (t.key === tab.key ? { ...t, activePane: paneKey } : t)));
    }
    if (activeKeyRef.current !== tab.key) setActiveKey(tab.key);
  }, []);

  /** Ask for a password/passphrase; resolves null when cancelled. */
  const askAuth = useCallback(
    (target: string, error: string, kind: AuthKind = 'password') =>
      new Promise<{ password: string; save: boolean } | null>((resolve) => setAuth({ kind, target, error, canSave: true, resolve })),
    [],
  );

  const describe = (target: PaneTarget): Pick<Pane, 'title' | 'subtitle' | 'env'> => {
    if (target.kind === 'local') {
      const sh = shellsRef.current.find((s) => s.id === target.shellId);
      const name = sh?.name ?? target.shellId;
      const folder = target.cwd?.split(/[\\/]/).filter(Boolean).pop();
      return folder ? { title: folder, subtitle: `${name} — ${target.cwd}`, env: '' } : { title: name, subtitle: `${name} (local)`, env: '' };
    }
    if (target.kind === 'log') return { title: `Log · ${target.title}`, subtitle: `Session log — ${target.title}`, env: '' };
    if (target.kind === 'rdp') {
      if (target.selector) return { title: 'WALLIX list', subtitle: 'WALLIX selector (bastion)', env: '' };
      if (target.adhoc) return { title: target.adhoc.name || target.adhoc.ip, subtitle: `${target.adhoc.ip} · direct`, env: '' };
      const m = rdpDataRef.current?.machines.find((x) => x.id === target.machineId);
      return { title: m?.name ?? 'Remote Desktop', subtitle: m ? machineDetail(m) : '', env: '' };
    }
    const host = target.hostId ? hostsRef.current.find((h) => h.id === target.hostId) : undefined;
    if (target.kind === 'sftp') {
      return { title: `SFTP · ${host?.name ?? 'host'}`, subtitle: `SFTP — ${host ? hostLabel(host) : ''}`, env: host?.env ?? '' };
    }
    return host ? { title: host.name, subtitle: hostLabel(host), env: host.env } : { title: target.spec ?? '', subtitle: target.spec ?? '', env: '' };
  };

  // Actions used by session callbacks; reassigned each render so they see fresh state.
  const actions = useRef<{ closePane(key: string): void; broadcast(key: string, data: string): boolean }>({
    closePane: () => {},
    broadcast: () => false,
  });

  const createPane = (target: PaneTarget): string => {
    const key = newKey();
    const info = describe(target);
    if (isTerminal(target)) {
      const session = new TermSession(
        target,
        {
          status: (status, extra) => patchPane(key, { status, ...extra }),
          dims: (cols, rows) => patchPane(key, { cols, rows }),
          auth: (kind, error) => {
            focusPane(key);
            return askAuth(info.subtitle, error, kind);
          },
          linked: ({ hostId, saved }) => {
            if (hostId) patchPane(key, { target: { kind: 'ssh', hostId } });
            if (saved) notify(`Saved ${info.subtitle} to your hosts`);
            void refresh(); // new host, saved password, last-used time
          },
          exited: () => actions.current.closePane(key),
          input: (d) => actions.current.broadcast(key, d),
          focused: () => focusPane(key),
          historyList: (query, anchor) => setHistoryList({ paneKey: key, query, anchor }),
          output: () => patchPane(key, { unread: true }),
        },
        optionsFor(target, appearanceRef.current),
      );
      sessions.current.set(key, session);
    }
    const isRdp = target.kind === 'rdp';
    const web = isRdp && !!rdpDataRef.current?.web;
    setPanes((prev) => ({
      ...prev,
      [key]: {
        key,
        target,
        ...info,
        status: isTerminal(target) || isRdp ? 'connecting' : 'connected',
        ...(isRdp ? { message: 'Starting Remote Desktop…', rdpMode: 'docked' as const, rdpReady: web, rdpWeb: web } : {}),
      },
    }));
    if (target.kind === 'rdp' && !web) void openRdp(key, target);
    return key;
  };

  /** Asks the engine for the session; its window appears once RdpView reports where. */
  const openRdp = async (key: string, target: RdpTarget) => {
    try {
      const r = await rdp.open({
        id: key,
        machineId: target.machineId,
        selector: target.selector,
        machine: target.adhoc ? { id: '', name: target.adhoc.name, ip: target.adhoc.ip, mode: 'direct', target: '', group: '', credentialId: null, autoType: 'auto', notes: '' } : undefined,
      });
      patchPane(key, { rdpReady: true, title: r.title, message: '' });
    } catch (e) {
      const msg = errorMessage(e);
      patchPane(key, { status: 'disconnected', rdpReady: false, message: rdpErrorText(msg) });
      if (msg.startsWith('BASTION:')) setRdpDialog({ kind: 'settings', tab: 'bastion' });
    }
  };

  const retryRdp = (key: string) => {
    const p = panesRef.current[key];
    if (p?.target.kind !== 'rdp') return;
    patchPane(key, { status: 'connecting', message: 'Starting Remote Desktop…' });
    void openRdp(key, p.target);
  };

  const addTab = (layoutKeys: string[], broadcast = false) => {
    const tab: Tab = {
      key: newKey(),
      layout: layoutKeys.length === 1 ? { type: 'pane', key: layoutKeys[0] } : gridLayout(layoutKeys, newKey),
      activePane: layoutKeys[0],
      zoomed: false,
      broadcast: broadcast && layoutKeys.length > 1,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveKey(tab.key);
    setFindOpen(false);
  };

  const openTab = (target: PaneTarget) => addTab([createPane(target)]);

  const defaultShell = () => shellsRef.current.find((s) => s.id === typingPrefs.defaultShell)?.id ?? shellsRef.current[0]?.id;

  const openLocal = (shellId = defaultShell(), cwd?: string) => {
    if (!shellId) {
      notify('No local shell found on this machine', 'error');
      return;
    }
    openTab({ kind: 'local', shellId, cwd });
  };

  // Opened from Explorer ("Open in Remterm") or with a folder argument.
  const launchHandled = useRef(false);
  const openLocalRef = useRef(openLocal);
  openLocalRef.current = openLocal;
  useEffect(() => {
    if (!settingsLoaded || shells.length === 0 || launchHandled.current) return;
    launchHandled.current = true;
    api
      .takeLaunchFolder()
      .then((folder) => {
        if (folder) openLocalRef.current(undefined, folder);
      })
      .catch(() => {});
    onLaunchOpen((folder) => openLocalRef.current(undefined, folder));
  }, [settingsLoaded, shells]);

  /** Splits the active pane; without a target the new pane duplicates it. */
  const split = (dir: 'row' | 'col' | 'auto', target?: PaneTarget) => {
    const tab = tabsRef.current.find((t) => t.key === activeKeyRef.current);
    if (!tab) {
      if (target) openTab(target);
      else openLocal();
      return;
    }
    if (leaves(tab.layout).length >= MAX_PANES) {
      notify(`A tab holds up to ${MAX_PANES} panes`, 'error');
      return;
    }
    const from = tab.activePane;
    const t = target ?? sessions.current.get(from)?.currentTarget ?? panes[from]?.target;
    if (!t) return;
    let d = dir;
    if (d === 'auto') {
      const p = panes[from];
      d = p?.cols && p?.rows && p.cols < p.rows * 2.6 ? 'col' : 'row';
    }
    const added = createPane(t);
    const layout = splitPane(tab.layout, from, added, d, newKey());
    setTabs((prev) => prev.map((x) => (x.key === tab.key ? { ...x, layout, activePane: added, zoomed: false } : x)));
  };

  const disposePanes = (keys: string[]) => {
    for (const k of keys) {
      sessions.current.get(k)?.dispose();
      sessions.current.delete(k);
      if (panesRef.current[k]?.target.kind === 'rdp' && !panesRef.current[k]?.rdpWeb) void rdp.close(k).catch(() => {});
    }
    setPanes((prev) => {
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
  };

  const closeTab = (tabKey: string) => {
    const prev = tabsRef.current;
    const tab = prev.find((t) => t.key === tabKey);
    if (!tab) return;
    disposePanes(leaves(tab.layout));
    const idx = prev.indexOf(tab);
    const next = prev.filter((t) => t !== tab);
    setTabs(next);
    setActiveKey((a) => (a === tabKey ? (next[Math.min(idx, next.length - 1)]?.key ?? null) : a));
    setFindOpen(false);
  };

  const closePane = (paneKey: string) => {
    const tab = tabOf(paneKey);
    if (!tab) return;
    const layout = removePane(tab.layout, paneKey);
    if (!layout) {
      closeTab(tab.key);
      return;
    }
    const nextActive =
      tab.activePane !== paneKey
        ? tab.activePane
        : (['left', 'up', 'right', 'down'] as Direction[]).map((d) => neighbor(tab.layout, paneKey, d)).find(Boolean) ?? leaves(layout)[0];
    disposePanes([paneKey]);
    setTabs((prev) =>
      prev.map((t) =>
        t.key === tab.key ? { ...t, layout, activePane: nextActive!, zoomed: false, broadcast: t.broadcast && leaves(layout).length > 1 } : t,
      ),
    );
    setFindOpen(false);
  };

  /** Runs `close` after asking, when it would end connected Remote Desktop sessions. */
  const confirmRdpClose = (keys: string[], close: () => void) => {
    const live = keys.filter((k) => panesRef.current[k]?.target.kind === 'rdp' && panesRef.current[k]?.status === 'connected');
    if (!live.length || rdpDataRef.current?.settings.confirmCloseConnected === false) {
      close();
      return;
    }
    setConfirm({
      title: 'Disconnect',
      message: `Disconnect from ${live.map((k) => panesRef.current[k]?.title).join(', ')}?`,
      confirmLabel: 'Disconnect',
      run: close,
    });
  };
  const requestCloseTab = (tabKey: string) => {
    const t = tabsRef.current.find((x) => x.key === tabKey);
    if (t) confirmRdpClose(leaves(t.layout), () => closeTab(tabKey));
  };
  const requestClosePane = (paneKey: string) => confirmRdpClose([paneKey], () => closePane(paneKey));

  const broadcast = (fromKey: string, data: string): boolean => {
    const tab = tabOf(fromKey);
    if (!tab?.broadcast) return false;
    for (const k of leaves(tab.layout)) sessions.current.get(k)?.send(data);
    return true;
  };

  actions.current = { closePane, broadcast };

  // Panes the user can see get no "unread" dot; others report new output.
  useEffect(() => {
    const visible = new Set<string>();
    for (const t of tabs) {
      if (t.key !== activeKey) continue;
      for (const k of leaves(t.layout)) if (!t.zoomed || k === t.activePane) visible.add(k);
    }
    sessions.current.forEach((s, k) => s.setWatching(visible.has(k)));
    const stale = [...visible].filter((k) => panes[k]?.unread);
    if (stale.length) setPanes((prev) => Object.fromEntries(Object.entries(prev).map(([k, p]) => [k, visible.has(k) ? { ...p, unread: false } : p])));
  }, [tabs, activeKey, panes]);

  const patchActiveTab = (fn: (t: Tab) => Partial<Tab>) => {
    if (!activeKey) return;
    setTabs((prev) => prev.map((t) => (t.key === activeKey ? { ...t, ...fn(t) } : t)));
  };

  const toggleZoom = () => activePaneCount > 1 && patchActiveTab((t) => ({ zoomed: !t.zoomed }));
  const toggleBroadcast = () => {
    if (activePaneCount < 2) return;
    const on = !activeTab?.broadcast;
    patchActiveTab(() => ({ broadcast: on }));
    notify(on ? `Typing goes to all ${activePaneCount} panes of this tab` : 'Broadcast input off');
  };

  const movePaneFocus = (dir: Direction) => {
    if (!activeTab) return;
    const n = neighbor(activeTab.layout, activeTab.activePane, dir);
    if (n) patchActiveTab(() => ({ activePane: n, zoomed: false }));
  };

  const cycleTab = (dir: 1 | -1) => {
    if (!tabs.length) return;
    const idx = tabs.findIndex((t) => t.key === activeKey);
    setActiveKey(tabs[(idx + dir + tabs.length) % tabs.length].key);
  };

  /** Opens every host (up to 16) side by side in one tab. */
  const connectHosts = (list: Host[], runText?: string) => {
    if (!list.length) return;
    if (list.length > MAX_PANES) notify(`Opening the first ${MAX_PANES} of ${list.length} hosts`);
    const keysList = list.slice(0, MAX_PANES).map((h) => createPane({ kind: 'ssh', hostId: h.id }));
    if (runText) keysList.forEach((k) => sessions.current.get(k)?.runWhenConnected(runText));
    addTab(keysList, list.length > 1);
  };

  // ---- snippets ----

  const runSnippet = (s: Snippet, execute: boolean) => {
    if (!activeSession) {
      notify('Open a terminal first — or use "Run on several hosts"');
      return;
    }
    if (snippetVars(s.command).length) setVarsRequest({ snippet: s, execute });
    else sendCommand(s.command, execute);
  };

  const snippetText = (command: string, execute: boolean) => command.replace(/\r?\n/g, '\r') + (execute ? '\r' : '');

  /** Sends to the active pane, or to every pane when broadcast is on. */
  const sendCommand = (command: string, execute: boolean) => {
    if (!activeTab || !activeSession) return;
    const text = snippetText(command, execute);
    const targets = activeTab.broadcast ? leaves(activeTab.layout) : [activeTab.activePane];
    const sent = targets.map((k) => sessions.current.get(k)?.send(text)).filter(Boolean).length;
    if (!sent) notify('This session is not connected', 'error');
    activeSession.focus();
  };

  const runOnHosts = (s: Snippet, hostIds: string[], command = s.command) => {
    connectHosts(
      hostIds.map((id) => hosts.find((h) => h.id === id)).filter(Boolean) as Host[],
      snippetText(command, true),
    );
    notify(`Running "${s.name}" on ${hostIds.length} host${hostIds.length === 1 ? '' : 's'} (broadcast is on in that tab)`);
  };

  /** Readable name for a history host key. */
  const historyHostLabel = (hostKey: string): string => {
    const [kind, id] = [hostKey.slice(0, hostKey.indexOf(':')), hostKey.slice(hostKey.indexOf(':') + 1)];
    if (kind === 'ssh') return hosts.find((h) => h.id === id)?.name ?? 'deleted host';
    if (kind === 'local') return shells.find((s) => s.id === id)?.name ?? id;
    return id;
  };

  // ---- hosts, groups, imports ----

  const runImport = async (fn: () => Promise<number>, what: string) => {
    try {
      const n = await fn();
      notify(n ? `Imported ${n} host${n === 1 ? '' : 's'} from ${what}` : `No new hosts found in ${what}`);
      if (n) {
        setPanel('hosts');
        await refresh();
      }
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  const saveHost = async (h: Host, secret: string, proxyPassword: string, forget: boolean, connect: boolean) => {
    if (forget && h.id) await api.clearSecret(h.id);
    const saved = await api.saveHost(h, secret, proxyPassword);
    await refresh();
    setEditingHost(null);
    if (connect) openTab({ kind: 'ssh', hostId: saved.id });
  };

  const saveSnippet = async (s: Snippet) => {
    await api.saveSnippet(s);
    await refresh();
    setEditingSnippet(undefined);
  };

  const askDeleteHost = (h: Host) =>
    setConfirm({
      title: 'Delete host',
      message: `Delete "${h.name}" (${hostLabel(h)})? Its saved password will also be removed from Credential Manager.`,
      confirmLabel: 'Delete',
      run: async () => {
        await api.deleteHost(h.id);
        await refresh();
      },
    });

  const askDeleteSnippet = (s: Snippet) =>
    setConfirm({
      title: 'Delete snippet',
      message: `Delete snippet "${s.name}"?`,
      confirmLabel: 'Delete',
      run: async () => {
        await api.deleteSnippet(s.id);
        await refresh();
      },
    });

  const openGroupDialog = (path: string | null) => {
    if (path === null || path.endsWith('/')) {
      setEditingGroup({ group: { ...EMPTY_GROUP, path: path ?? '' }, isNew: true });
      return;
    }
    const existing = groups.find((g) => g.path === path);
    setEditingGroup({ group: existing ?? { ...EMPTY_GROUP, path }, isNew: false });
  };

  // ---- tunnels ----

  const toggleTunnel = async (t: Tunnel) => {
    const st = tunnelStatus[t.id]?.state;
    if (st === 'running' || st === 'starting') {
      await api.stopTunnel(t.id);
      return;
    }
    let password = '';
    for (;;) {
      try {
        await api.startTunnel(t.id, password);
        notify(`${t.label} is running`);
        return;
      } catch (e) {
        const msg = errorMessage(e);
        if (!msg.startsWith('AUTH_FAILED')) {
          notify(cleanError(msg), 'error');
          return;
        }
        const h = hosts.find((x) => x.id === t.hostId);
        const res = await askAuth(h ? hostLabel(h) : 'SSH host', password ? cleanError(msg) : '');
        if (!res) return;
        password = res.password;
        if (res.save && h) await api.saveHost(h, res.password).then(refresh).catch(() => {});
      }
    }
  };

  // ---- workspaces ----

  const saveWorkspace = () => {
    if (!activeTab) return;
    const targets: Record<string, PaneTarget> = {};
    for (const k of leaves(activeTab.layout)) {
      const t = sessions.current.get(k)?.currentTarget ?? panes[k]?.target;
      if (t && t.kind !== 'log') targets[k] = t;
    }
    if (!Object.keys(targets).length) {
      notify('Nothing to save in this tab', 'error');
      return;
    }
    let layout = activeTab.layout;
    for (const k of leaves(layout)) if (!targets[k]) layout = removePane(layout, k) ?? layout;
    setPrompt({
      title: 'Save workspace',
      label: 'Name',
      initial: activePane?.title ?? '',
      placeholder: 'Prod: API + DB + logs',
      confirmLabel: 'Save',
      run: async (name) => {
        const existing = workspaces.find((w) => w.name.toLowerCase() === name.trim().toLowerCase());
        await api.saveWorkspace({ id: existing?.id ?? '', name, data: { layout, targets, activePane: activeTab.activePane, broadcast: activeTab.broadcast } });
        await refresh();
        setPrompt(null);
        notify(existing ? `Updated workspace "${name}"` : `Saved workspace "${name}"`);
      },
    });
  };

  const openWorkspace = (w: Workspace) => {
    const d = w.data;
    const map: Record<string, string> = {};
    for (const [oldKey, target] of Object.entries(d.targets)) map[oldKey] = createPane(target);
    const tab: Tab = {
      key: newKey(),
      layout: remapLayout(d.layout, map, newKey),
      activePane: map[d.activePane] ?? Object.values(map)[0],
      zoomed: false,
      broadcast: d.broadcast,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveKey(tab.key);
  };

  // ---- files dropped from Explorer ----

  useEffect(
    () =>
      events.fileDrop((x, y, paths) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        const panelEl = el?.closest<HTMLElement>('[data-fs-panel]');
        if (panelEl) {
          const fsId = panelEl.dataset.fsPanel;
          const dir = panelEl.dataset.fsPath;
          if (fsId && dir) {
            void transfers.start('local', paths, fsId, dir).catch((e) => notify(cleanError(errorMessage(e)), 'error'));
          } else notify('Open a folder in that pane first', 'error');
          return;
        }
        const paneKey = el?.closest<HTMLElement>('[data-pane-key]')?.dataset.paneKey;
        const s = paneKey ? sessions.current.get(paneKey) : activeSession;
        if (s) s.send(paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' '));
      }),
    [activeSession, notify],
  );

  const changeFont = (delta: number) => setAppearance((a) => ({ ...a, fontSize: Math.max(9, Math.min(32, a.fontSize + delta)) }));

  // ---- Remote Desktop actions ----

  const showRdpPanel = () => {
    setSidebarOpen(true);
    setPanel('rdp');
  };

  const connectRdp = (target: RdpTarget, inSplit = false) => {
    const d = rdpDataRef.current;
    if (!d) {
      showRdpPanel();
      notify(rdpStatus?.needsPassword ? 'Unlock Remote Desktop first' : rdpError || 'Remote Desktop is still starting…', rdpError ? 'error' : 'info');
      return;
    }
    const m = target.machineId ? d.machines.find((x) => x.id === target.machineId) : undefined;
    if ((target.selector || m?.mode === 'bastion') && !d.bastion.host.trim()) {
      notify('Enter the WALLIX bastion address first');
      setRdpDialog({ kind: 'settings', tab: 'bastion' });
      return;
    }
    if (d.external && !d.web) {
      // macOS: the session opens in the system's RDP client.
      rdp
        .launch({ machineId: target.machineId, selector: target.selector, machine: target.adhoc ? { name: target.adhoc.name, ip: target.adhoc.ip, mode: 'direct' } : undefined })
        .then((r) => {
          notify(r.message);
          void refreshRdp();
        })
        .catch((e) => {
          const msg = errorMessage(e);
          if (msg.startsWith('NO_RDP_CLIENT:')) {
            setConfirm({
              title: 'Install a Remote Desktop app',
              message:
                "This Mac has no Remote Desktop app yet. Install Microsoft's free “Windows App” from the App Store, then connect again — Remterm fills in the server and the WALLIX login for you. (FreeRDP works too: brew install freerdp.)",
              confirmLabel: 'Open App Store',
              run: () => openURL('macappstore://apps.apple.com/app/id1295203466'),
            });
            return;
          }
          if (msg.startsWith('BASTION:')) setRdpDialog({ kind: 'settings', tab: 'bastion' });
          notify(rdpErrorText(msg), 'error');
        });
      return;
    }
    if (inSplit) split('auto', target);
    else openTab(target);
  };

  const quickRdp = (host: string, inSplit = false) => connectRdp({ kind: 'rdp', adhoc: { name: host, ip: host } }, inSplit);

  const lockRdp = async () => {
    try {
      setRdpStatus(await rdp.lock());
    } catch (e) {
      notify(rdpErrorText(errorMessage(e)), 'error');
    }
  };

  const rdpAction = (action: 'fill' | 'fullscreen' | 'popout' | 'reconnect' | 'disconnect' | 'cad', key = activePane?.key) => {
    const web = key ? webRdpSessions.get(key) : undefined;
    if (key && panesRef.current[key]?.rdpWeb) {
      if (action === 'reconnect') web?.reconnect();
      else if (action === 'disconnect') web?.disconnect();
      else if (action === 'cad') web?.ctrlAltDel();
      return;
    }
    if (action === 'cad') return;
    if (key && panesRef.current[key]?.target.kind === 'rdp') void rdp[action](key).catch((e) => notify(errorMessage(e), 'error'));
  };

  // Events from the RDP engine (reassigned every render so it sees fresh state).
  rdpEventRef.current = (name, d) => {
    switch (name) {
      case 'session':
        patchPane(d.id, { status: d.status, title: d.title, message: d.message, rdpMode: d.mode });
        break;
      case 'closed':
        if (tabOf(d.id)) closePane(d.id);
        break;
      case 'closeRequest':
        closePane(d.id);
        break;
      case 'notify':
        notify(d.text);
        break;
      case 'changed':
      case 'locked':
        void refreshRdp();
        break;
      case 'hotkey': {
        const k: string = d.key;
        if (k === 'next') cycleTab(1);
        else if (k === 'prev') cycleTab(-1);
        else if (k.startsWith('tab')) {
          const t = tabsRef.current[Number(k.slice(3)) - 1];
          if (t) setActiveKey(t.key);
        } else if (k === 'quick') setPaletteOpen(true);
        else if (k === 'close') requestClosePane(d.id);
        else if (k === 'sidebar') setSidebarOpen((v) => !v);
        else if (k === 'lock') void lockRdp();
        break;
      }
      case 'engine-exit':
        setPanes((prev) =>
          Object.fromEntries(
            Object.entries(prev).map(([k, p]) => [
              k,
              p.target.kind === 'rdp' ? { ...p, rdpReady: false, rdpMode: 'docked', status: 'disconnected', message: 'The Remote Desktop engine stopped.' } : p,
            ]),
          ),
        );
        setRdpData(null);
        setRdpStatus(null);
        window.setTimeout(() => void refreshRdp(), 500);
        break;
    }
  };

  const rdpOpenStatus: Record<string, TabStatus> = {};
  for (const p of Object.values(panes)) {
    if (p.target.kind !== 'rdp' || !p.target.machineId) continue;
    const cur = rdpOpenStatus[p.target.machineId];
    if (!cur || STATUS_RANK[p.status] > STATUS_RANK[cur]) rdpOpenStatus[p.target.machineId] = p.status;
  }

  const rdpCtx: RdpCtx = {
    available: rdpAvailable,
    status: rdpStatus,
    data: rdpData,
    error: rdpError,
    openStatus: rdpOpenStatus,
    connect: (m, inSplit) => connectRdp({ kind: 'rdp', machineId: m.id }, inSplit),
    switchTo: (m) => {
      const p = Object.values(panesRef.current).find((x) => x.target.kind === 'rdp' && x.target.machineId === m.id);
      if (p) focusPane(p.key);
    },
    connectAll: (list) => {
      const run = () => list.forEach((m) => connectRdp({ kind: 'rdp', machineId: m.id }));
      if (list.length <= 5) run();
      else setConfirm({ title: 'Connect all', message: `Open ${list.length} Remote Desktop sessions?`, confirmLabel: `Open ${list.length}`, run });
    },
    openSelector: () => connectRdp({ kind: 'rdp', selector: true }),
    edit: (m, group) => setRdpDialog({ kind: 'machine', machine: m, group }),
    save: (m) => void rdp.saveMachine(m).then(refreshRdp).catch((e) => notify(errorMessage(e), 'error')),
    remove: (list, what) =>
      setConfirm({
        title: list.length > 1 ? 'Delete machines' : 'Delete machine',
        message: `Delete ${what}? Saved logins are kept; open sessions stay connected.`,
        confirmLabel: 'Delete',
        run: async () => {
          await rdp.deleteMachines(list.map((m) => m.id));
          await refreshRdp();
        },
      }),
    renameGroup: (name) =>
      setPrompt({
        title: 'Rename group',
        label: 'Name',
        initial: name === 'Ungrouped' ? '' : name,
        confirmLabel: 'Rename',
        run: async (to) => {
          await rdp.renameGroup(name, to);
          await refreshRdp();
          setPrompt(null);
        },
      }),
    logins: () => setRdpDialog({ kind: 'logins' }),
    settings: (tab) => setRdpDialog({ kind: 'settings', tab }),
    importList: () => setRdpDialog({ kind: 'import' }),
    lock: () => void lockRdp(),
    refresh: () => void refreshRdp(),
    notify,
  };
  const activeRdp = activePane?.target.kind === 'rdp' ? activePane : undefined;

  // ---- dragging tabs: onto a side of another tab (split), the tab bar (reorder), outside (own window) ----

  const [tabDrag, setTabDrag] = useState<TabDrag | null>(null);
  const termAreaRef = useRef<HTMLDivElement>(null);
  const suppressTabClick = useRef(false);

  const rdpPanesOf = (tabKey: string) => {
    const t = tabsRef.current.find((x) => x.key === tabKey);
    return t ? leaves(t.layout).filter((k) => panesRef.current[k]?.target.kind === 'rdp' && panesRef.current[k]?.rdpReady) : [];
  };

  const hitTest = (x: number, y: number, d: TabDrag): Pick<TabDrag, 'outside' | 'side' | 'strip'> => {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return { outside: true, side: null, strip: null };
    const bar = document.querySelector('.tabbar .tabs')?.getBoundingClientRect();
    if (bar && y >= bar.top - 6 && y <= bar.bottom + 6 && x >= bar.left - 20) {
      const els = [...document.querySelectorAll<HTMLElement>('.tabbar [data-tab-key]')];
      let strip = els.length;
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (x < r.left + r.width / 2) {
          strip = i;
          break;
        }
      }
      return { outside: false, side: null, strip };
    }
    const a = termAreaRef.current?.getBoundingClientRect();
    if (!a || !d.target || d.target === d.key || x < a.left || x > a.right || y < a.top || y > a.bottom) return { outside: false, side: null, strip: null };
    const fx = (x - a.left) / a.width;
    const fy = (y - a.top) / a.height;
    const dist: [DropSide, number][] = [
      ['left', fx],
      ['right', 1 - fx],
      ['top', fy],
      ['bottom', 1 - fy],
    ];
    const [side, near] = dist.reduce((m, c) => (c[1] < m[1] ? c : m));
    return { outside: false, side: near < 0.34 ? side : null, strip: null };
  };

  /** Puts tab `srcKey` next to tab `dstKey` (one tab, split) on the given side. */
  const mergeTab = (srcKey: string, dstKey: string, side: DropSide) => {
    const src = tabsRef.current.find((t) => t.key === srcKey);
    const dst = tabsRef.current.find((t) => t.key === dstKey);
    if (!src || !dst || src === dst) return;
    if (leaves(src.layout).length + leaves(dst.layout).length > MAX_PANES) {
      notify(`A tab holds up to ${MAX_PANES} panes`, 'error');
      return;
    }
    const first = side === 'left' || side === 'top';
    const layout: Tab['layout'] = {
      type: 'split',
      key: newKey(),
      dir: side === 'left' || side === 'right' ? 'row' : 'col',
      ratio: 0.5,
      a: first ? src.layout : dst.layout,
      b: first ? dst.layout : src.layout,
    };
    setTabs((prev) => prev.filter((t) => t.key !== srcKey).map((t) => (t.key === dstKey ? { ...t, layout, activePane: src.activePane, zoomed: false } : t)));
    setActiveKey(dstKey);
  };

  const moveTab = (key: string, index: number) =>
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.key === key);
      if (from < 0) return prev;
      const next = prev.filter((t) => t.key !== key);
      next.splice(index > from ? index - 1 : index, 0, prev[from]);
      return next;
    });

  const onTabPointerDown = (key: string, e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    const start = { x: e.clientX, y: e.clientY };
    let drag: TabDrag | null = null;
    let torn = ''; // RDP pane whose window currently follows the mouse
    try {
      el.setPointerCapture(pointerId); // keeps the events coming when the pointer leaves the window
    } catch {
      /* ignore */
    }
    const physical = (ev: PointerEvent) => {
      const s = window.devicePixelRatio || 1;
      return { x: Math.round(ev.screenX * s), y: Math.round(ev.screenY * s) };
    };
    const move = (ev: PointerEvent) => {
      if (!drag) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 7) return;
        const list = tabsRef.current;
        const t = list.find((x) => x.key === key);
        const p = panesRef.current[t?.activePane ?? ''];
        drag = {
          key,
          title: p?.title ?? 'Tab',
          kind: p?.target.kind ?? 'ssh',
          status: p?.status ?? 'connected',
          x: ev.clientX,
          y: ev.clientY,
          outside: false,
          side: null,
          strip: null,
          target: activeKeyRef.current !== key ? activeKeyRef.current : null,
          restore: null,
          canPopOut: rdpPanesOf(key).length > 0,
          torn: false,
        };
        document.body.classList.add('tab-dragging');
      }
      // Dragging the tab you are looking at: once the pointer is over the content area,
      // show a neighbour there to drop onto (not earlier, so reordering doesn't flicker).
      const area = termAreaRef.current?.getBoundingClientRect();
      if (!drag.target && area && ev.clientY > area.top + 8 && ev.clientX >= area.left && ev.clientX <= area.right) {
        const list = tabsRef.current;
        const i = list.findIndex((x) => x.key === key);
        const other = list[i - 1] ?? list[i + 1];
        if (other) {
          drag = { ...drag, target: other.key, restore: key };
          setActiveKey(other.key);
        }
      }
      const hit = hitTest(ev.clientX, ev.clientY, drag);
      // Out of the window with a single Remote Desktop session: tear it off — its own window
      // follows the mouse; coming back over Remterm puts it back in the tab.
      const rdpKeys = drag.canPopOut ? rdpPanesOf(key) : [];
      if (hit.outside && !torn && rdpKeys.length === 1) {
        torn = rdpKeys[0];
        void rdp.popout(torn, { ...physical(ev), follow: true }).catch((err) => notify(errorMessage(err), 'error'));
      } else if (!hit.outside && torn) {
        void rdp.dock(torn).catch(() => {});
        torn = '';
      }
      drag = { ...drag, x: ev.clientX, y: ev.clientY, ...hit, torn: !!torn };
      setTabDrag(drag);
    };
    const end = (ev: PointerEvent, cancelled: boolean) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      try {
        el.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
      document.body.classList.remove('tab-dragging');
      const d = drag;
      if (!d) return;
      suppressTabClick.current = true;
      window.setTimeout(() => (suppressTabClick.current = false), 0);
      setTabDrag(null);
      if (torn) {
        // The torn-off window stays where it was dropped (the engine follows the real button).
        setActiveKey(d.key);
        return;
      }
      if (cancelled) {
        if (d.restore) setActiveKey(d.restore);
        return;
      }
      if (d.outside) {
        setActiveKey(d.key);
        const keys = rdpPanesOf(d.key);
        if (!keys.length) {
          notify('Only Remote Desktop tabs can open in their own window — drop a tab on a side of another tab to see both together');
          return;
        }
        const at = physical(ev);
        keys.forEach((k, i) => void rdp.popout(k, { x: at.x + i * 30, y: at.y + i * 30 }).catch((err) => notify(errorMessage(err), 'error')));
      } else if (d.side && d.target) mergeTab(d.key, d.target, d.side);
      else if (d.strip !== null) {
        moveTab(d.key, d.strip);
        if (d.restore) setActiveKey(d.key);
      } else if (d.restore) setActiveKey(d.restore);
    };
    const up = (ev: PointerEvent) => end(ev, false);
    const cancel = (ev: PointerEvent) => end(ev, true);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
  };

  // ---- global shortcuts (capture phase, so they win over the terminal) ----

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlayOpen) return;
      const ctrl = e.ctrlKey || e.metaKey;
      // Keys typed in an in-tab RDP session belong to the remote machine, except Remterm's Ctrl+Alt ones.
      const inRdp = !!(e.target as HTMLElement | null)?.closest?.('.web-rdp');
      if (inRdp && !(ctrl && e.altKey)) return;
      if (ctrl && e.altKey && !e.shiftKey && (e.key === 'PageDown' || e.key === 'PageUp')) {
        e.preventDefault();
        e.stopPropagation();
        cycleTab(e.key === 'PageDown' ? 1 : -1);
        return;
      }
      if (inRdp && ctrl && e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        const t = tabs[Number(e.key) - 1];
        if (t) setActiveKey(t.key);
        return;
      }
      const k = e.key.toLowerCase();
      const altShift = e.altKey && e.shiftKey && !ctrl;
      let handled = true;
      if ((ctrl && e.shiftKey && k === 'p') || e.key === 'F1') setPaletteOpen(true);
      else if (ctrl && e.shiftKey && k === 't') setPaletteOpen(true);
      else if (ctrl && e.shiftKey && e.code === 'Backquote') openLocal();
      else if (ctrl && e.shiftKey && k === 'w') activePane && requestClosePane(activePane.key);
      else if (ctrl && e.shiftKey && k === 'f') activeSession && setFindOpen(true);
      else if (ctrl && e.shiftKey && k === 'r') (activeRdp ? rdpAction('reconnect') : activeSession?.reconnect());
      else if (ctrl && e.altKey && !e.shiftKey && activeRdp && k === 'k') rdpAction('fill');
      else if (ctrl && e.altKey && !e.shiftKey && activeRdp && e.key === 'Enter') rdpAction('fullscreen');
      else if (ctrl && e.altKey && !e.shiftKey && rdpData && k === 'p') setPaletteOpen(true);
      else if (ctrl && e.altKey && !e.shiftKey && rdpData?.hasMaster && k === 'l') void lockRdp();
      else if (ctrl && e.shiftKey && k === 'b') setSidebarOpen((v) => !v);
      else if (ctrl && e.shiftKey && k === 'z') toggleZoom();
      else if (ctrl && e.shiftKey && k === 'a') toggleBroadcast();
      else if (ctrl && !e.shiftKey && k === 's' && activeTab) saveWorkspace();
      else if (ctrl && !e.shiftKey && e.key === ',') setAppearanceOpen((v) => !v);
      else if (altShift && (e.code === 'Equal' || e.code === 'NumpadAdd')) split('row');
      else if (altShift && (e.code === 'Minus' || e.code === 'NumpadSubtract')) split('col');
      else if (altShift && e.code === 'KeyD') split('auto');
      else if (e.altKey && !e.shiftKey && !ctrl && e.key.startsWith('Arrow'))
        movePaneFocus(({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const)[e.key as 'ArrowLeft']);
      else if (ctrl && e.key === 'Tab') cycleTab(e.shiftKey ? -1 : 1);
      else if (ctrl && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const t = tabs[Number(e.key) - 1];
        if (t) setActiveKey(t.key);
      } else if (ctrl && !e.shiftKey && (e.key === '=' || e.key === '+')) changeFont(1);
      else if (ctrl && !e.shiftKey && e.key === '-') changeFont(-1);
      else if (ctrl && !e.shiftKey && e.key === '0') setAppearance((a) => ({ ...a, fontSize: DEFAULT_APPEARANCE.fontSize }));
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // ---- palette ----

  const paletteItems: PaletteItem[] = (() => {
    const sshTarget = (h: Host): PaneTarget => ({ kind: 'ssh', hostId: h.id });
    const items: PaletteItem[] = byRecent(hosts).map((h) => ({
      id: 'h:' + h.id,
      kind: 'Connect',
      label: h.name,
      detail: hostLabel(h),
      env: h.env,
      keywords: `${h.group} ${(h.tags ?? []).join(' ')}`,
      run: (o) => (o?.split ? split('auto', sshTarget(h)) : openTab(sshTarget(h))),
    }));
    for (const m of [...(rdpData?.machines ?? [])].sort((a, b) => lastUsedMs(b) - lastUsedMs(a))) {
      items.push({
        id: 'r:' + m.id,
        kind: 'Remote',
        label: m.name,
        detail: machineDetail(m),
        keywords: `${m.group} ${m.ip} rdp remote desktop`,
        run: (o) => rdpCtx.connect(m, o?.split),
      });
    }
    for (const h of hosts.filter((x) => (x.protocol || 'ssh') === 'ssh')) {
      items.push({ id: 'f:' + h.id, kind: 'Connect', label: `SFTP: ${h.name}`, detail: 'Files', env: h.env, run: () => openTab({ kind: 'sftp', hostId: h.id }) });
    }
    for (const s of shells) {
      const target: PaneTarget = { kind: 'local', shellId: s.id };
      items.push({ id: 'l:' + s.id, kind: 'Local', label: s.name, detail: 'Local terminal', run: (o) => (o?.split ? split('auto', target) : openTab(target)) });
    }
    for (const w of workspaces) {
      items.push({ id: 'w:' + w.id, kind: 'Action', label: `Open workspace: ${w.name}`, run: () => openWorkspace(w) });
    }
    for (const t of tunnels) {
      const on = tunnelStatus[t.id]?.state === 'running';
      items.push({ id: 't:' + t.id, kind: 'Action', label: `${on ? 'Stop' : 'Start'} port forwarding: ${t.label}`, run: () => void toggleTunnel(t) });
    }
    if (activeSession) {
      for (const s of snippets) {
        items.push({
          id: 's:' + s.id,
          kind: 'Run',
          label: s.group ? `${s.group}: ${s.name}` : s.name,
          detail: s.description || s.command,
          keywords: s.command,
          run: () => runSnippet(s, true),
        });
      }
    }
    if (activeTab) {
      items.push(
        { id: 'a:split-r', kind: 'Action', label: 'Split right', detail: 'Alt+Shift+=', run: () => split('row') },
        { id: 'a:split-d', kind: 'Action', label: 'Split down', detail: 'Alt+Shift+-', run: () => split('col') },
        { id: 'a:save-ws', kind: 'Action', label: 'Save tab as workspace…', detail: 'Ctrl+S', run: saveWorkspace },
      );
      if (activePaneCount > 1) {
        items.push(
          { id: 'a:zoom', kind: 'Action', label: activeTab.zoomed ? 'Unzoom pane' : 'Zoom pane', detail: 'Ctrl+Shift+Z', run: toggleZoom },
          { id: 'a:broadcast', kind: 'Action', label: activeTab.broadcast ? 'Stop broadcasting input' : 'Broadcast input to all panes', detail: 'Ctrl+Shift+A', run: toggleBroadcast },
        );
      }
      if (activeSession) {
        items.push(
          { id: 'a:reconnect', kind: 'Action', label: 'Reconnect current pane', detail: 'Ctrl+Shift+R', run: () => activeSession.reconnect() },
          { id: 'a:find', kind: 'Action', label: 'Find in terminal', detail: 'Ctrl+Shift+F', run: () => setFindOpen(true) },
        );
      }
      if (activeRdp) {
        items.push(
          { id: 'a:rdp-fill', kind: 'Action', label: 'Fill a saved login in this session', detail: 'Ctrl+Alt+K', run: () => rdpAction('fill') },
          { id: 'a:rdp-full', kind: 'Action', label: 'Fullscreen Remote Desktop', detail: 'Ctrl+Alt+Enter', run: () => rdpAction('fullscreen') },
          { id: 'a:rdp-pop', kind: 'Action', label: 'Open session in its own window', run: () => rdpAction('popout') },
          { id: 'a:rdp-reconnect', kind: 'Action', label: 'Reconnect Remote Desktop', detail: 'Ctrl+Alt+R', run: () => rdpAction('reconnect') },
        );
      }
      items.push({ id: 'a:close', kind: 'Action', label: 'Close current pane', detail: 'Ctrl+Shift+W', run: () => activePane && requestClosePane(activePane.key) });
    }
    if (rdpData) {
      items.push(
        { id: 'a:wallix', kind: 'Action', label: 'Open the WALLIX list', run: rdpCtx.openSelector },
        { id: 'a:new-machine', kind: 'Action', label: 'New Remote Desktop machine…', run: () => rdpCtx.edit(null) },
        { id: 'a:import-wallix', kind: 'Action', label: 'Import WALLIX list…', run: rdpCtx.importList },
        { id: 'a:rdp-logins', kind: 'Action', label: 'Remote Desktop logins…', run: rdpCtx.logins },
        { id: 'a:rdp-settings', kind: 'Action', label: 'Remote Desktop settings (bastion, auto-fill, display)…', run: () => rdpCtx.settings() },
      );
      if (rdpData.hasMaster) items.push({ id: 'a:lock', kind: 'Action', label: 'Lock Remterm', detail: 'Ctrl+Alt+L', run: () => void lockRdp() });
    }
    items.push(
      { id: 'a:appearance', kind: 'Action', label: 'Settings: background, colors, font, typing…', detail: 'Ctrl+,', run: () => setAppearanceOpen(true) },
      { id: 'a:new-host', kind: 'Action', label: 'New host…', run: () => setEditingHost({ host: null }) },
      { id: 'a:new-group', kind: 'Action', label: 'New group…', run: () => openGroupDialog(null) },
      { id: 'a:gen-key', kind: 'Action', label: 'Generate SSH key…', run: () => setKeyDialog('generate') },
      { id: 'a:new-tunnel', kind: 'Action', label: 'New port forwarding…', run: () => setEditingTunnel(null) },
      { id: 'a:import', kind: 'Action', label: 'Import hosts from ~/.ssh/config', run: () => void runImport(api.importSSHConfig, '~/.ssh/config') },
      { id: 'a:import-putty', kind: 'Action', label: 'Import PuTTY sessions', run: () => void runImport(api.importPuTTY, 'PuTTY') },
      { id: 'a:new-snippet', kind: 'Action', label: 'New snippet…', run: () => setEditingSnippet(null) },
      { id: 'a:sidebar', kind: 'Action', label: 'Toggle sidebar', detail: 'Ctrl+Shift+B', run: () => setSidebarOpen((v) => !v) },
    );
    return items;
  })();

  // ---- sidebar context ----

  const ctx: SidebarCtx = {
    hosts,
    groups,
    snippets,
    identities,
    keys,
    tunnels,
    tunnelStatus,
    workspaces,
    hasSession: !!activeSession,
    canSaveWorkspace: !!activeTab,
    connect: (h, inSplit) => (inSplit ? split('auto', { kind: 'ssh', hostId: h.id }) : openTab({ kind: 'ssh', hostId: h.id })),
    openSftp: (h) => openTab({ kind: 'sftp', hostId: h.id }),
    editHost: (h, group) => setEditingHost({ host: h, group }),
    duplicateHost: (h) => setEditingHost({ host: { ...h, id: '', name: `${h.name} (copy)`, hasSecret: false, lastUsed: 0 } }),
    deleteHost: askDeleteHost,
    editGroup: openGroupDialog,
    connectGroup: (path) => connectHosts(hostsInGroup(hosts, path)),
    importSSHConfig: () => void runImport(api.importSSHConfig, '~/.ssh/config'),
    importPuTTY: () => void runImport(api.importPuTTY, 'PuTTY'),
    runSnippet,
    runSnippetOnHosts: (s) => setPickHosts(s),
    editSnippet: setEditingSnippet,
    deleteSnippet: askDeleteSnippet,
    runHistory: (command, execute) => (activeSession ? sendCommand(command, execute) : notify('Open a terminal first')),
    clearHistory: () =>
      setConfirm({
        title: 'Clear command history',
        message: 'Forget every remembered command on all servers? Shell history on the servers themselves is not touched.',
        confirmLabel: 'Clear history',
        run: () => history.clear(),
      }),
    historyHostLabel,
    generateKey: () => setKeyDialog('generate'),
    importKey: () => setKeyDialog('import'),
    openKey: (k) => setKeyDialog(k),
    editIdentity: setEditingIdentity,
    editTunnel: setEditingTunnel,
    toggleTunnel: (t) => void toggleTunnel(t),
    deleteTunnel: (t) =>
      setConfirm({
        title: 'Delete port forwarding',
        message: `Delete "${t.label}"? It is stopped first if it is running.`,
        confirmLabel: 'Delete',
        run: async () => {
          await api.deleteTunnel(t.id);
          await refresh();
        },
      }),
    saveWorkspace,
    openWorkspace,
    renameWorkspace: (w) =>
      setPrompt({
        title: 'Rename workspace',
        label: 'Name',
        initial: w.name,
        confirmLabel: 'Rename',
        run: async (name) => {
          await api.saveWorkspace({ ...w, name });
          await refresh();
          setPrompt(null);
        },
      }),
    deleteWorkspace: (w) =>
      setConfirm({
        title: 'Delete workspace',
        message: `Delete the saved workspace "${w.name}"? Open tabs are not affected.`,
        confirmLabel: 'Delete',
        run: async () => {
          await api.deleteWorkspace(w.id);
          await refresh();
        },
      }),
    openLog: (logId, title) => openTab({ kind: 'log', logId, title }),
    notify,
  };

  // ---- render ----

  const tabViews: TabView[] = useMemo(
    () =>
      tabs.map((t) => {
        const keysList = leaves(t.layout);
        const p = panes[t.activePane];
        const anyProd = keysList.some((k) => panes[k]?.env === 'prod');
        return {
          key: t.key,
          title: p?.title ?? '…',
          subtitle: keysList.map((k) => panes[k]?.subtitle).filter(Boolean).join('  |  '),
          env: anyProd ? 'prod' : (p?.env ?? ''),
          status: p?.status ?? 'connecting',
          paneCount: keysList.length,
          broadcast: t.broadcast && keysList.length > 1,
          local: p?.target.kind === 'local',
          kind: p?.target.kind ?? 'ssh',
          unread: t.key !== activeKey && keysList.some((k) => panes[k]?.unread),
        };
      }),
    [tabs, panes, activeKey],
  );

  const bgCss = backgroundCss(appearance);
  const schemeBg = getScheme(appearance.scheme).theme.background;
  const prodVisible = activeTab && leaves(activeTab.layout).some((k) => panes[k]?.env === 'prod');

  const rdpOnScreen = !!activeTab && leaves(activeTab.layout).some((k) => panes[k]?.target.kind === 'rdp');

  const renderPane = (pane: Pane, active: boolean, shown: boolean) => {
    const t = pane.target;
    if (t.kind === 'rdp' && pane.rdpWeb)
      return (
        <WebRdpView
          id={pane.key}
          pane={pane}
          request={{ machineId: t.machineId, selector: t.selector, machine: t.adhoc ? { name: t.adhoc.name, ip: t.adhoc.ip, mode: 'direct' } : undefined }}
          active={active && shown}
          onStatus={(status, message) => patchPane(pane.key, { status, ...(message !== undefined ? { message } : {}) })}
          onClose={() => closePane(pane.key)}
        />
      );
    if (t.kind === 'rdp')
      return (
        <RdpView
          id={pane.key}
          pane={pane}
          shown={shown}
          active={active}
          locked={appLocked}
          onRetry={() => retryRdp(pane.key)}
          onClose={() => closePane(pane.key)}
        />
      );
    if (t.kind === 'sftp') return <SftpView hostId={t.hostId} hosts={hosts} auth={(target, error) => askAuth(target, error)} notify={notify} />;
    if (t.kind === 'log') return <LogView logId={t.logId} theme={getScheme(appearance.scheme).theme} fontSize={appearance.fontSize} notify={notify} />;
    return null;
  };

  return (
    <div className="app">
      {sidebarOpen && <Sidebar ctx={ctx} rdp={rdpCtx} panel={panel} onPanel={setPanel} />}

      <main className="main">
        <TabBar
          tabs={tabViews}
          activeKey={activeKey}
          shells={shells}
          hasActive={!!activeTab}
          activePaneCount={activePaneCount}
          zoomed={!!activeTab?.zoomed}
          broadcast={!!activeTab?.broadcast}
          onSelect={(k) => !suppressTabClick.current && setActiveKey(k)}
          onTabPointerDown={onTabPointerDown}
          draggingKey={tabDrag?.key ?? null}
          dropIndex={tabDrag?.strip ?? null}
          onClose={requestCloseTab}
          onNewSsh={() => setPaletteOpen(true)}
          onNewRdp={rdpAvailable ? () => (rdpData ? setPaletteOpen(true) : showRdpPanel()) : undefined}
          rdp={activeRdp ? { connected: activeRdp.status === 'connected', mode: activeRdp.rdpMode ?? 'docked', web: !!activeRdp.rdpWeb } : null}
          onRdp={(a) => rdpAction(a)}
          onNewLocal={(id) => openLocal(id)}
          onSplit={(d) => split(d)}
          onToggleZoom={toggleZoom}
          onToggleBroadcast={toggleBroadcast}
          onAppearance={() => setAppearanceOpen((v) => !v)}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
        />
        <div ref={termAreaRef} className={`term-area ${prodVisible ? 'prod' : ''} ${bgCss ? 'has-bg' : ''}`}>
          {bgCss && tabs.length > 0 && (
            <>
              <div className="term-bg" style={{ background: bgCss, filter: appearance.blur ? `blur(${appearance.blur}px)` : undefined }} />
              <div className="term-bg-dim" style={{ background: hexToRgba(schemeBg, appearance.dim / 100) }} />
            </>
          )}
          {tabs.map((t) => (
            <TabPanes
              key={t.key}
              tab={t}
              visible={t.key === activeKey}
              panes={panes}
              sessions={sessions.current}
              onActivate={focusPane}
              onRatio={(splitKey, ratio) => setTabs((prev) => prev.map((x) => (x.key === t.key ? { ...x, layout: setRatio(x.layout, splitKey, ratio) } : x)))}
              onClosePane={requestClosePane}
              renderPane={renderPane}
            />
          ))}
          {tabs.length === 0 && (
            <Welcome
              hosts={hosts}
              shells={shells}
              machines={rdpAvailable && rdpData ? rdpData.machines : null}
              rdpExternal={!!rdpData?.external}
              onLocal={(id) => openLocal(id)}
              onConnect={(h) => openTab({ kind: 'ssh', hostId: h.id })}
              onQuickConnect={(spec) => openTab({ kind: 'ssh', spec })}
              onQuickRdp={rdpAvailable ? (host) => quickRdp(host) : undefined}
              onRdp={(m) => rdpCtx.connect(m)}
              onNewHost={() => setEditingHost({ host: null })}
              onImport={() => void runImport(api.importSSHConfig, '~/.ssh/config')}
              onRdpPanel={showRdpPanel}
            />
          )}
          {tabDrag && <TabDropOverlay drag={tabDrag} targetTitle={tabDrag.target ? tabViews.find((v) => v.key === tabDrag.target)?.title : undefined} />}
          {findOpen && activeSession && <FindBar key={activePane?.key} session={activeSession} onClose={() => setFindOpen(false)} />}
        </div>
        <StatusBar
          pane={activePane}
          paneCount={activePaneCount}
          zoomed={!!activeTab?.zoomed}
          broadcast={!!activeTab?.broadcast}
          hostCount={hosts.length}
          fontSize={appearance.fontSize}
        />
      </main>

      {appearanceOpen && (
        <AppearancePanel
          value={appearance}
          onChange={setAppearance}
          typing={typing}
          onTyping={setTyping}
          shells={shells}
          onRdpSettings={
            rdpData
              ? () => {
                  setAppearanceOpen(false);
                  setRdpDialog({ kind: 'settings' });
                }
              : undefined
          }
          onClose={() => setAppearanceOpen(false)}
        />
      )}
      {historyList && sessions.current.get(historyList.paneKey) && (
        <HistoryList
          query={historyList.query}
          hostKey={sessions.current.get(historyList.paneKey)!.historyKey}
          anchor={historyList.anchor}
          hostLabel={historyHostLabel}
          onPick={(command, run) => {
            sessions.current.get(historyList.paneKey)?.useHistory(command, run);
            setHistoryList(null);
          }}
          onClose={() => {
            sessions.current.get(historyList.paneKey)?.focus();
            setHistoryList(null);
          }}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          items={paletteItems}
          onQuickConnect={(spec, inSplit) => (inSplit ? split('auto', { kind: 'ssh', spec }) : openTab({ kind: 'ssh', spec }))}
          onQuickRdp={rdpAvailable ? (host, inSplit) => quickRdp(host, inSplit) : undefined}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {editingHost && (
        <HostDialog
          host={editingHost.host}
          defaultGroup={editingHost.group}
          hosts={hosts}
          groups={groups}
          identities={identities}
          keys={keys}
          onSave={saveHost}
          onClose={() => setEditingHost(null)}
        />
      )}
      {editingGroup && (
        <GroupDialog
          group={editingGroup.group}
          isNew={editingGroup.isNew}
          hosts={hosts}
          identities={identities}
          onSaved={() => {
            setEditingGroup(null);
            void refresh();
          }}
          onDelete={(path) =>
            setConfirm({
              title: 'Delete group',
              message: `Delete the group "${path}"? Its hosts are kept and move up to the parent group; the group's settings are removed.`,
              confirmLabel: 'Delete group',
              run: async () => {
                await api.deleteGroup(path);
                setEditingGroup(null);
                await refresh();
              },
            })
          }
          onClose={() => setEditingGroup(null)}
        />
      )}
      {editingIdentity !== undefined && (
        <IdentityDialog
          identity={editingIdentity}
          keys={keys}
          onSaved={() => {
            setEditingIdentity(undefined);
            void refresh();
          }}
          onDelete={(i) =>
            setConfirm({
              title: 'Delete identity',
              message: `Delete "${i.label}"? Hosts and groups using it fall back to their own credentials.`,
              confirmLabel: 'Delete',
              run: async () => {
                await api.deleteIdentity(i.id);
                setEditingIdentity(undefined);
                await refresh();
              },
            })
          }
          onClose={() => setEditingIdentity(undefined)}
        />
      )}
      {keyDialog === 'generate' && (
        <GenerateKeyDialog
          onSaved={(k) => {
            void refresh();
            setKeyDialog(k);
            notify(`Generated ${k.label} — install it on a server below`);
          }}
          onClose={() => setKeyDialog(null)}
        />
      )}
      {keyDialog === 'import' && (
        <ImportKeyDialog
          onSaved={(k) => {
            void refresh();
            setKeyDialog(null);
            notify(`Imported ${k.label}`);
          }}
          onClose={() => setKeyDialog(null)}
        />
      )}
      {keyDialog && typeof keyDialog === 'object' && (
        <KeyDetailsDialog
          keyItem={keys.find((k) => k.id === keyDialog.id) ?? keyDialog}
          hosts={hosts}
          notify={notify}
          onChanged={() => void refresh()}
          onDelete={(k) =>
            setConfirm({
              title: 'Delete key',
              message: `Delete "${k.label}" from the keychain? Hosts using it will need another way to log in. The public key stays on servers until you remove it there.`,
              confirmLabel: 'Delete key',
              run: async () => {
                await api.deleteKey(k.id);
                setKeyDialog(null);
                await refresh();
              },
            })
          }
          onClose={() => setKeyDialog(null)}
        />
      )}
      {editingTunnel !== undefined && (
        <TunnelDialog
          tunnel={editingTunnel}
          hosts={hosts}
          onSaved={() => {
            setEditingTunnel(undefined);
            void refresh();
          }}
          onClose={() => setEditingTunnel(undefined)}
        />
      )}
      {pickHosts && (
        <PickHostsDialog
          title={`Run "${pickHosts.name}" on…`}
          hosts={hosts.filter((h) => (h.protocol || 'ssh') !== 'serial')}
          confirmLabel="Open & run"
          onPick={(ids) => {
            const s = pickHosts;
            setPickHosts(null);
            if (snippetVars(s.command).length) setVarsRequest({ snippet: s, execute: true, hostIds: ids });
            else runOnHosts(s, ids);
          }}
          onClose={() => setPickHosts(null)}
        />
      )}
      {varsRequest && (
        <SnippetVarsDialog
          snippet={varsRequest.snippet}
          execute={varsRequest.execute}
          onCancel={() => {
            setVarsRequest(null);
            activeSession?.focus();
          }}
          onSubmit={(command) => {
            const req = varsRequest;
            setVarsRequest(null);
            if (req.hostIds) runOnHosts(req.snippet, req.hostIds, command);
            else sendCommand(command, req.execute);
          }}
        />
      )}
      {editingSnippet !== undefined && (
        <SnippetDialog
          snippet={editingSnippet}
          groups={[...new Set(snippets.map((s) => s.group).filter(Boolean))].sort()}
          onSave={saveSnippet}
          onClose={() => setEditingSnippet(undefined)}
        />
      )}
      {prompt && (
        <PromptDialog
          title={prompt.title}
          label={prompt.label}
          initial={prompt.initial}
          placeholder={prompt.placeholder}
          confirmLabel={prompt.confirmLabel}
          onCancel={() => setPrompt(null)}
          onSubmit={prompt.run}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const c = confirm;
            setConfirm(null);
            try {
              await c.run();
            } catch (e) {
              notify(errorMessage(e), 'error');
            }
          }}
        />
      )}
      {auth && (
        <AuthDialog
          kind={auth.kind}
          target={auth.target}
          error={auth.error}
          canSave={auth.canSave}
          onCancel={() => {
            auth.resolve(null);
            setAuth(null);
          }}
          onSubmit={(password, save) => {
            auth.resolve({ password, save });
            setAuth(null);
          }}
        />
      )}
      {rdpDialog?.kind === 'machine' && rdpData && (
        <MachineDialog
          machine={rdpDialog.machine}
          defaultGroup={rdpDialog.group}
          data={rdpData}
          onSaved={(m, connect) => {
            setRdpDialog(null);
            void refreshRdp().then(() => connect && connectRdp({ kind: 'rdp', machineId: m.id }));
          }}
          onClose={() => setRdpDialog(null)}
        />
      )}
      {rdpDialog?.kind === 'logins' && rdpData && (
        <LoginsDialog data={rdpData} onChanged={() => void refreshRdp()} onClose={() => setRdpDialog(null)} />
      )}
      {rdpDialog?.kind === 'settings' && rdpData && (
        <RdpSettingsDialog
          data={rdpData}
          tab={rdpDialog.tab}
          onLogins={() => setRdpDialog({ kind: 'logins' })}
          onChanged={() => void refreshRdp()}
          onClose={() => setRdpDialog(null)}
        />
      )}
      {rdpDialog?.kind === 'import' && rdpData && (
        <ImportDialog
          data={rdpData}
          onImported={(n) => {
            setRdpDialog(null);
            notify(n ? `Imported ${n} machine${n === 1 ? '' : 's'}` : 'No new machines found');
            showRdpPanel();
            void refreshRdp();
          }}
          onClose={() => setRdpDialog(null)}
        />
      )}
      {appLocked && <LockScreen onUnlocked={() => void refreshRdp()} />}
      {toast && (
        <div key={toast.id} className={`toast ${toast.kind} ${rdpOnScreen ? 'low' : ''}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}

