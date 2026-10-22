import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Bastion, Machine, RdpCredential, RdpData, RdpSettings, RdpStatus } from './types';

// Remote Desktop lives in the RemtermRdp engine; Go relays JSON calls to it
// (App.RdpCall) and its events arrive as 'rdp:event' (name, data).

const call = <T>(method: string, params: object = {}): Promise<T> =>
  window.go.main.App.RdpCall(method, JSON.stringify(params)).then((s: string) => (s ? JSON.parse(s) : null) as T);

export interface OpenRequest {
  id: string;
  machineId?: string;
  machine?: Partial<Machine>;
  selector?: boolean;
  /** A login typed in the connect prompt, used for this session only. */
  username?: string;
  password?: string;
}

export const rdp = {
  available: () => window.go.main.App.RdpAvailable() as Promise<boolean>,
  status: () => call<RdpStatus>('status'),
  unlock: (password: string) => call<RdpStatus>('unlock', { password }),
  lock: () => call<RdpStatus>('lock'),

  data: () => call<RdpData>('data'),
  /** password: null/undefined keeps the machine's saved password, a string replaces it. */
  saveMachine: (machine: Machine, password?: string | null) => call<Machine>('saveMachine', { machine, password: password ?? null }),
  deleteMachines: (ids: string[]) => call<void>('deleteMachines', { ids }),
  renameGroup: (from: string, to: string) => call<void>('renameGroup', { from, to }),
  saveCredential: (credential: Omit<RdpCredential, 'hasPassword'>, password: string | null) =>
    call<RdpCredential>('saveCredential', { credential: { ...credential, hasPassword: false }, password }),
  deleteCredential: (id: string) => call<void>('deleteCredential', { id }),
  setDefaultCredential: (id: string) => call<void>('setDefaultCredential', { id }),
  saveBastion: (bastion: Bastion, password: string | null) => call<void>('saveBastion', { bastion, password }),
  saveSettings: (settings: RdpSettings) => call<void>('saveSettings', { settings }),
  importPreview: (text: string) => call<{ count: number; duplicates: number; skipped: number; sample: string[] }>('importPreview', { text }),
  import: (text: string, group: string, credentialId: string) => call<{ imported: number }>('import', { text, group, credentialId }),
  setMasterPassword: (current: string, password: string) => call<RdpStatus>('setMasterPassword', { current, password }),
  openDiag: () => call<void>('openDiag'),

  /** In-tab session through IronRDP: where to connect (Remterm's relay) and as whom. */
  webSession: (req: Omit<OpenRequest, 'id'> & { username?: string; password?: string }) =>
    call<{
      needsLogin: boolean; // nothing saved: the tab asks
      loginUser: string; // user name to prefill
      mode: 'bastion' | 'direct';
      proxy: string;
      token: string;
      destination: string;
      username: string;
      password: string;
      domain: string;
    }>('webSession', req),
  /** Save what was typed in a tab's login form (bastion login, or a login for that machine). */
  rememberLogin: (req: { machineId?: string; mode: string; username: string; password: string }) => call<void>('rememberLogin', req),
  /** macOS: open the machine in the system's RDP client (password goes to the clipboard). */
  launch: (req: Omit<OpenRequest, 'id'>) => call<{ message: string }>('launch', req),
  open: (req: OpenRequest) => call<{ title: string; tooltip: string; machineId: string }>('open', req),
  bounds: (id: string, r: { x: number; y: number; w: number; h: number }, visible: boolean) => call<void>('bounds', { id, ...r, visible }),
  close: (id: string) => call<void>('close', { id }),
  reconnect: (id: string) => call<void>('reconnect', { id }),
  disconnect: (id: string) => call<void>('disconnect', { id }),
  focus: (id: string) => call<void>('focus', { id }),
  refresh: (id: string) => call<void>('refresh', { id }),
  fill: (id: string) => call<void>('fill', { id }),
  /** Types a login picked in Remterm's list (key: 'bastion' or a login id). */
  fillWith: (id: string, key: string) => call<void>('fillWith', { id, key }),
  /** Small picture of the session for the tab's hover preview ('' when there is none yet). */
  thumb: (id: string) => call<string>('thumb', { id }),
  fullscreen: (id: string) => call<void>('fullscreen', { id }),
  popout: (id: string, screen?: { x: number; y: number; follow?: boolean }) => call<void>('popout', { id, ...screen }),
  clip: (id: string, rects: { x: number; y: number; w: number; h: number }[]) => call<void>('clip', { id, rects }),
  dock: (id: string) => call<void>('dock', { id }),
  snapshot: (id: string) => call<string>('snapshot', { id }),
};

export const onRdpEvent = (cb: (name: string, data: any) => void) => window.runtime.EventsOn('rdp:event', cb);

/** The WALLIX selector-bypass login: {target}:{auth}:{user}, empty parts dropped (same rule as the engine). */
export function bastionLogin(template: string, target: string, auth: string, user: string): string {
  if (!target.trim()) return user;
  let s = (template.trim() || '{target}:{auth}:{user}')
    .replaceAll('{target}', target.trim())
    .replaceAll('{auth}', auth.trim())
    .replaceAll('{user}', user.trim());
  while (s.includes('::')) s = s.replace('::', ':');
  return s.replace(/^:+|:+$/g, '');
}

export const makeTarget = (name: string, ip: string) => (ip.trim() ? `Interactive@${name.trim()}-${ip.trim()}:RDP` : `Interactive@${name.trim()}:RDP`);

export const machineDetail = (m: Machine) => (m.mode === 'direct' ? `${m.ip} · direct` : m.target || 'WALLIX list');

/** Second line of a machine in the lists: user@address, or the WALLIX target. */
export const machineSub = (m: Machine) =>
  m.mode === 'direct' ? `${m.username ? m.username + '@' : ''}${m.ip}` : m.ip || m.target || 'WALLIX list';

export const lastUsedMs =(m: Machine) => (m.lastUsed ? Date.parse(m.lastUsed) || 0 : 0);

/** The login a connection would use without asking: its own, an assigned saved login, or the default one. */
export function machineHasLogin(m: Machine, d: RdpData): boolean {
  if (m.username) return true;
  if (m.credentialId === 'none') return false;
  if (m.credentialId) return d.credentials.some((c) => c.id === m.credentialId);
  return d.credentials.length > 0;
}

/** A bare host or IP (optionally :port), for "Remote Desktop to …" quick connect. */
export const RDP_HOST_RE = /^(\d{1,3}(\.\d{1,3}){3}|[a-z0-9][\w-]*(\.[\w-]+)+)(:\d{1,5})?$/i;

// ---------------------------------------------------------------------------
// Covering native windows. An RDP session is a real window above the web
// page, so anything drawn over it would be hidden behind it. Every overlay
// registers here while open:
//  - small ones (menus, popups, the settings drawer) with their rectangle:
//    the session stays live and a hole of that shape is cut out of it;
//  - full ones (dialogs with a backdrop, the lock screen) without one: the
//    session is replaced by a still picture until they close.

/** Viewport rectangle in CSS pixels. */
export interface CoverRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

let nextCover = 1;
const covers = new Map<number, CoverRect | null>();
let coverVersion = 0;
const coverSubs = new Set<() => void>();
const notifyCovers = () => {
  coverVersion++;
  coverSubs.forEach((f) => f());
};
const sameRect = (a: CoverRect | null | undefined, b: CoverRect | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

export const cover = {
  /** rect null = covers the whole window. */
  push(rect: CoverRect | null = null) {
    const id = nextCover++;
    covers.set(id, rect);
    notifyCovers();
    return {
      update(r: CoverRect | null) {
        if (!covers.has(id) || sameRect(covers.get(id), r)) return;
        covers.set(id, r);
        notifyCovers();
      },
      done() {
        if (covers.delete(id)) notifyCovers();
      },
    };
  },
  version: () => coverVersion,
  full: () => [...covers.values()].some((r) => r === null),
  rects: () => [...covers.values()].filter((r): r is CoverRect => r !== null),
  subscribe(f: () => void) {
    coverSubs.add(f);
    return () => {
      coverSubs.delete(f);
    };
  },
};

/** Marks the calling overlay as covering the whole window while mounted (and `active`). */
export function useCover(active = true) {
  useEffect(() => {
    if (!active) return;
    return cover.push(null).done;
  }, [active]);
}

/** Marks an element (menu, popup, drawer) as covering its own rectangle, plus its shadow. */
export function useCoverRect(ref: RefObject<HTMLElement>, active = true, margin = 10) {
  const handle = useRef<ReturnType<typeof cover.push> | null>(null);
  const measure = (): CoverRect | null => {
    const el = ref.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.floor(r.left - margin), y: Math.floor(r.top - margin), w: Math.ceil(r.width + 2 * margin), h: Math.ceil(r.height + 2 * margin) };
  };
  useLayoutEffect(() => {
    if (!active || !ref.current) return;
    const h = cover.push(measure());
    handle.current = h;
    const update = () => h.update(measure());
    const ro = new ResizeObserver(update);
    ro.observe(ref.current);
    window.addEventListener('resize', update);
    // Opening animations scale the element for a moment; measure again after them.
    const t = window.setTimeout(update, 180);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      window.clearTimeout(t);
      handle.current = null;
      h.done();
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  // Position can change on any render (menus place themselves after mounting).
  useLayoutEffect(() => {
    handle.current?.update(measure());
  });
}
