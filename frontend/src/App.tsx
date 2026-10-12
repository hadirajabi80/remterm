import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, onLaunchOpen } from './api';
import type { CursorAnchor } from './autocomplete';
import { history, typingPrefs } from './history';
import { leaves, neighbor, removePane, setRatio, splitPane, type Direction } from './layout';
import { TermSession, type AuthKind, type TermOptions } from './terminal';
import { DEFAULT_APPEARANCE, backgroundCss, getScheme } from './themes';
import type { Appearance, Host, LocalShell, Pane, PaneTarget, Snippet, Tab } from './types';
import { byRecent, hostLabel, snippetVars } from './util';
import { AppearancePanel } from './components/AppearancePanel';
import { CommandPalette, type PaletteItem } from './components/CommandPalette';
import { FindBar } from './components/FindBar';
import { HistoryList } from './components/HistoryList';
import { HostDialog } from './components/HostDialog';
import { AuthDialog, ConfirmDialog } from './components/Modal';
import { Sidebar, type Panel } from './components/Sidebar';
import { SnippetDialog } from './components/SnippetDialog';
import { SnippetVarsDialog } from './components/SnippetVarsDialog';
import { StatusBar } from './components/StatusBar';
import { TabBar, type TabView } from './components/TabBar';
import { TabPanes } from './components/TabPanes';
import { Welcome } from './components/Welcome';

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

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

function termOptions(a: Appearance): TermOptions {
  const theme = getScheme(a.scheme).theme;
  // With a background picture the terminal canvas is transparent.
  return { fontSize: a.fontSize, theme: a.background === 'none' ? theme : { ...theme, background: 'rgba(0,0,0,0)' } };
}

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

export default function App() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [shells, setShells] = useState<LocalShell[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [panes, setPanes] = useState<Record<string, Pane>>({});
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('hosts');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [editingHost, setEditingHost] = useState<Host | null | undefined>(undefined);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [auth, setAuth] = useState<AuthRequest | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [varsRequest, setVarsRequest] = useState<{ snippet: Snippet; execute: boolean } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [typing, setTyping] = useState({ ...typingPrefs });
  const [historyList, setHistoryList] = useState<{ paneKey: string; query: string; anchor: CursorAnchor | null } | null>(null);

  const sessions = useRef(new Map<string, TermSession>());
  // Latest state for callbacks fired from terminal sessions.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
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
    editingHost !== undefined ||
    editingSnippet !== undefined ||
    confirm ||
    auth ||
    paletteOpen ||
    varsRequest ||
    historyList
  );

  const notify = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    setToast({ id: Date.now(), text, kind });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), toast.kind === 'error' ? 6000 : 3000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const refresh = useCallback(async () => {
    const [h, s] = await Promise.all([api.listHosts(), api.listSnippets()]);
    setHosts(h);
    setSnippets(s);
  }, []);

  useEffect(() => {
    refresh().catch((e) => notify(errorMessage(e), 'error'));
    api.listShells().then(setShells).catch(() => {});
    history.load().catch(() => {});
    api
      .getSettings()
      .then((raw) => {
        const saved = raw ? (JSON.parse(raw) as { appearance?: Partial<Appearance>; typing?: Partial<typeof typingPrefs> }) : {};
        setAppearance({ ...DEFAULT_APPEARANCE, fontSize: legacyFontSize(), ...saved.appearance });
        setTyping({ ...typingPrefs, ...saved.typing });
      })
      .catch(() => {})
      .finally(() => setSettingsLoaded(true));
  }, [refresh, notify]);

  // Apply appearance to every terminal and the chrome; persist (debounced).
  useEffect(() => {
    const opts = termOptions(appearance);
    sessions.current.forEach((s) => s.setOptions(opts));
    document.documentElement.style.setProperty('--term-bg', getScheme(appearance.scheme).theme.background);
    if (!settingsLoaded) return;
    const t = window.setTimeout(() => {
      api.saveSettings(JSON.stringify({ appearance, typing })).catch((e) => notify(errorMessage(e), 'error'));
    }, 400);
    return () => window.clearTimeout(t);
  }, [appearance, typing, settingsLoaded, notify]);

  useEffect(() => {
    Object.assign(typingPrefs, typing);
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

  const describe = (target: PaneTarget): Pick<Pane, 'title' | 'subtitle' | 'env'> => {
    if (target.kind === 'local') {
      const sh = shellsRef.current.find((s) => s.id === target.shellId);
      const name = sh?.name ?? target.shellId;
      const folder = target.cwd?.split(/[\\/]/).filter(Boolean).pop();
      return folder
        ? { title: folder, subtitle: `${name} — ${target.cwd}`, env: '' }
        : { title: name, subtitle: `${name} (local)`, env: '' };
    }
    const host = target.hostId ? hostsRef.current.find((h) => h.id === target.hostId) : undefined;
    return host
      ? { title: host.name, subtitle: hostLabel(host), env: host.env }
      : { title: target.spec ?? '', subtitle: target.spec ?? '', env: '' };
  };

  // Actions used by session callbacks; reassigned each render so they see fresh state.
  const actions = useRef<{ closePane(key: string): void; broadcast(key: string, data: string): boolean }>({
    closePane: () => {},
    broadcast: () => false,
  });

  const createPane = (target: PaneTarget): string => {
    const key = newKey();
    const info = describe(target);
    const session = new TermSession(
      target,
      {
        status: (status, extra) => patchPane(key, { status, ...extra }),
        dims: (cols, rows) => patchPane(key, { cols, rows }),
        auth: (kind, error) =>
          new Promise((resolve) => {
            focusPane(key);
            setAuth({ kind, target: info.subtitle, error, canSave: true, resolve });
          }),
        linked: ({ hostId, saved }) => {
          if (hostId) patchPane(key, { target: { kind: 'ssh', hostId } });
          if (saved) notify(`Saved ${info.subtitle} to your hosts`);
          void refresh(); // new host, saved password, last-used time
        },
        exited: () => actions.current.closePane(key),
        input: (d) => actions.current.broadcast(key, d),
        focused: () => focusPane(key),
        historyList: (query, anchor) => setHistoryList({ paneKey: key, query, anchor }),
      },
      termOptions(appearanceRef.current),
    );
    sessions.current.set(key, session);
    setPanes((prev) => ({ ...prev, [key]: { key, target, ...info, status: 'connecting' } }));
    return key;
  };

  const openTab = (target: PaneTarget) => {
    const paneKey = createPane(target);
    const tab: Tab = { key: newKey(), layout: { type: 'pane', key: paneKey }, activePane: paneKey, zoomed: false, broadcast: false };
    setTabs((prev) => [...prev, tab]);
    setActiveKey(tab.key);
    setFindOpen(false);
  };

  const defaultShell = () =>
    shellsRef.current.find((s) => s.id === typingPrefs.defaultShell)?.id ?? shellsRef.current[0]?.id;

  const openLocal = (shellId = defaultShell(), cwd?: string) => {
    if (!shellId) {
      notify('No local shell found on this machine', 'error');
      return;
    }
    openTab({ kind: 'local', shellId, cwd });
  };

  // Opened from Explorer ("Open in Termora") or with a folder argument.
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
    const from = tab.activePane;
    const t = target ?? sessions.current.get(from)?.currentTarget;
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
        : (['left', 'up', 'right', 'down'] as Direction[]).map((d) => neighbor(tab.layout, paneKey, d)).find(Boolean) ??
          leaves(layout)[0];
    disposePanes([paneKey]);
    setTabs((prev) =>
      prev.map((t) =>
        t.key === tab.key
          ? { ...t, layout, activePane: nextActive!, zoomed: false, broadcast: t.broadcast && leaves(layout).length > 1 }
          : t,
      ),
    );
    setFindOpen(false);
  };

  const broadcast = (fromKey: string, data: string): boolean => {
    const tab = tabOf(fromKey);
    if (!tab?.broadcast) return false;
    for (const k of leaves(tab.layout)) sessions.current.get(k)?.send(data);
    return true;
  };

  actions.current = { closePane, broadcast };

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

  // ---- snippets ----

  const runSnippet = (s: Snippet, execute: boolean) => {
    if (!activeSession) {
      notify('Open a connection first');
      return;
    }
    if (snippetVars(s.command).length) setVarsRequest({ snippet: s, execute });
    else sendCommand(s.command, execute);
  };

  /** Sends to the active pane, or to every pane when broadcast is on. */
  const sendCommand = (command: string, execute: boolean) => {
    if (!activeTab || !activeSession) return;
    const text = command.replace(/\r?\n/g, '\r') + (execute ? '\r' : '');
    const targets = activeTab.broadcast ? leaves(activeTab.layout) : [activeTab.activePane];
    const sent = targets.map((k) => sessions.current.get(k)?.send(text)).filter(Boolean).length;
    if (!sent) notify('This session is not connected', 'error');
    activeSession.focus();
  };

  /** Readable name for a history host key. */
  const historyHostLabel = (hostKey: string): string => {
    const [kind, id] = [hostKey.slice(0, hostKey.indexOf(':')), hostKey.slice(hostKey.indexOf(':') + 1)];
    if (kind === 'ssh') return hosts.find((h) => h.id === id)?.name ?? 'deleted host';
    if (kind === 'local') return shells.find((s) => s.id === id)?.name ?? id;
    return id;
  };

  // ---- hosts ----

  const importConfig = async () => {
    try {
      const n = await api.importSSHConfig();
      notify(n ? `Imported ${n} host${n === 1 ? '' : 's'} from ~/.ssh/config` : 'No new hosts found in ~/.ssh/config');
      if (n) {
        setPanel('hosts');
        await refresh();
      }
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  const saveHost = async (h: Host, secret: string, forget: boolean, connect: boolean) => {
    if (forget && h.id) await api.clearSecret(h.id);
    const saved = await api.saveHost(h, secret);
    await refresh();
    setEditingHost(undefined);
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

  const changeFont = (delta: number) =>
    setAppearance((a) => ({ ...a, fontSize: Math.max(9, Math.min(32, a.fontSize + delta)) }));

  // ---- global shortcuts (capture phase, so they win over the terminal) ----

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlayOpen) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const altShift = e.altKey && e.shiftKey && !ctrl;
      let handled = true;
      if ((ctrl && e.shiftKey && k === 'p') || e.key === 'F1') setPaletteOpen(true);
      else if (ctrl && e.shiftKey && k === 't') setPaletteOpen(true);
      else if (ctrl && e.shiftKey && e.code === 'Backquote') openLocal();
      else if (ctrl && e.shiftKey && k === 'w') activePane && closePane(activePane.key);
      else if (ctrl && e.shiftKey && k === 'f') activeKey && setFindOpen(true);
      else if (ctrl && e.shiftKey && k === 'r') activeSession?.reconnect();
      else if (ctrl && e.shiftKey && k === 'b') setSidebarOpen((v) => !v);
      else if (ctrl && e.shiftKey && k === 'z') toggleZoom();
      else if (ctrl && e.shiftKey && k === 'a') toggleBroadcast();
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
      run: (o) => (o?.split ? split('auto', sshTarget(h)) : openTab(sshTarget(h))),
    }));
    for (const s of shells) {
      const target: PaneTarget = { kind: 'local', shellId: s.id };
      items.push({
        id: 'l:' + s.id,
        kind: 'Local',
        label: s.name,
        detail: 'Local terminal',
        run: (o) => (o?.split ? split('auto', target) : openTab(target)),
      });
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
      );
      if (activePaneCount > 1) {
        items.push(
          { id: 'a:zoom', kind: 'Action', label: activeTab.zoomed ? 'Unzoom pane' : 'Zoom pane', detail: 'Ctrl+Shift+Z', run: toggleZoom },
          {
            id: 'a:broadcast',
            kind: 'Action',
            label: activeTab.broadcast ? 'Stop broadcasting input' : 'Broadcast input to all panes',
            detail: 'Ctrl+Shift+A',
            run: toggleBroadcast,
          },
        );
      }
      items.push(
        { id: 'a:reconnect', kind: 'Action', label: 'Reconnect current pane', detail: 'Ctrl+Shift+R', run: () => activeSession?.reconnect() },
        { id: 'a:find', kind: 'Action', label: 'Find in terminal', detail: 'Ctrl+Shift+F', run: () => setFindOpen(true) },
        { id: 'a:close', kind: 'Action', label: 'Close current pane', detail: 'Ctrl+Shift+W', run: () => activePane && closePane(activePane.key) },
      );
    }
    items.push(
      { id: 'a:appearance', kind: 'Action', label: 'Appearance: background, colors, font…', detail: 'Ctrl+,', run: () => setAppearanceOpen(true) },
      { id: 'a:new-host', kind: 'Action', label: 'New host…', run: () => setEditingHost(null) },
      { id: 'a:import', kind: 'Action', label: 'Import hosts from ~/.ssh/config', run: () => void importConfig() },
      { id: 'a:new-snippet', kind: 'Action', label: 'New snippet…', run: () => setEditingSnippet(null) },
      { id: 'a:sidebar', kind: 'Action', label: 'Toggle sidebar', detail: 'Ctrl+Shift+B', run: () => setSidebarOpen((v) => !v) },
    );
    return items;
  })();

  // ---- render ----

  const tabViews: TabView[] = useMemo(
    () =>
      tabs.map((t) => {
        const keys = leaves(t.layout);
        const p = panes[t.activePane];
        const anyProd = keys.some((k) => panes[k]?.env === 'prod');
        return {
          key: t.key,
          title: p?.title ?? '…',
          subtitle: keys.map((k) => panes[k]?.subtitle).filter(Boolean).join('  |  '),
          env: anyProd ? 'prod' : (p?.env ?? ''),
          status: p?.status ?? 'connecting',
          paneCount: keys.length,
          broadcast: t.broadcast && keys.length > 1,
          local: p?.target.kind === 'local',
        };
      }),
    [tabs, panes],
  );

  const bgCss = backgroundCss(appearance);
  const schemeBg = getScheme(appearance.scheme).theme.background;
  const prodVisible = activeTab && leaves(activeTab.layout).some((k) => panes[k]?.env === 'prod');

  return (
    <div className="app">
      {sidebarOpen && (
        <Sidebar
          hosts={hosts}
          snippets={snippets}
          panel={panel}
          onPanel={setPanel}
          hasSession={!!activeSession}
          onConnect={(h) => openTab({ kind: 'ssh', hostId: h.id })}
          onEditHost={setEditingHost}
          onDeleteHost={askDeleteHost}
          onImport={() => void importConfig()}
          onRunSnippet={runSnippet}
          onEditSnippet={setEditingSnippet}
          onDeleteSnippet={askDeleteSnippet}
          historyHostLabel={historyHostLabel}
          onRunHistory={(command, execute) => {
            if (activeSession) sendCommand(command, execute);
            else notify('Open a terminal first');
          }}
          onClearHistory={() =>
            setConfirm({
              title: 'Clear command history',
              message: 'Forget every remembered command on all servers? Shell history on the servers themselves is not touched.',
              confirmLabel: 'Clear history',
              run: () => history.clear(),
            })
          }
        />
      )}

      <main className="main">
        <TabBar
          tabs={tabViews}
          activeKey={activeKey}
          shells={shells}
          hasActive={!!activeTab}
          activePaneCount={activePaneCount}
          zoomed={!!activeTab?.zoomed}
          broadcast={!!activeTab?.broadcast}
          onSelect={setActiveKey}
          onClose={closeTab}
          onNewSsh={() => setPaletteOpen(true)}
          onNewLocal={(id) => openLocal(id)}
          onSplit={(d) => split(d)}
          onToggleZoom={toggleZoom}
          onToggleBroadcast={toggleBroadcast}
          onAppearance={() => setAppearanceOpen((v) => !v)}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
        />
        <div className={`term-area ${prodVisible ? 'prod' : ''} ${bgCss ? 'has-bg' : ''}`}>
          {bgCss && tabs.length > 0 && (
            <>
              <div
                className="term-bg"
                style={{ background: bgCss, filter: appearance.blur ? `blur(${appearance.blur}px)` : undefined }}
              />
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
              onRatio={(splitKey, ratio) =>
                setTabs((prev) => prev.map((x) => (x.key === t.key ? { ...x, layout: setRatio(x.layout, splitKey, ratio) } : x)))
              }
              onClosePane={closePane}
            />
          ))}
          {tabs.length === 0 && (
            <Welcome
              hosts={hosts}
              shells={shells}
              onLocal={(id) => openLocal(id)}
              onConnect={(h) => openTab({ kind: 'ssh', hostId: h.id })}
              onQuickConnect={(spec) => openTab({ kind: 'ssh', spec })}
              onNewHost={() => setEditingHost(null)}
              onImport={() => void importConfig()}
            />
          )}
          {findOpen && activeSession && (
            <FindBar key={activePane?.key} session={activeSession} onClose={() => setFindOpen(false)} />
          )}
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
          onQuickConnect={(spec, inSplit) =>
            inSplit ? split('auto', { kind: 'ssh', spec }) : openTab({ kind: 'ssh', spec })
          }
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {editingHost !== undefined && (
        <HostDialog host={editingHost} hosts={hosts} onSave={saveHost} onClose={() => setEditingHost(undefined)} />
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
            setVarsRequest(null);
            sendCommand(command, varsRequest.execute);
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
      {toast && (
        <div key={toast.id} className={`toast ${toast.kind}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}
