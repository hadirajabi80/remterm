import { useEffect } from 'react';
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
}

export const rdp = {
  available: () => window.go.main.App.RdpAvailable() as Promise<boolean>,
  status: () => call<RdpStatus>('status'),
  unlock: (password: string) => call<RdpStatus>('unlock', { password }),
  lock: () => call<RdpStatus>('lock'),

  data: () => call<RdpData>('data'),
  saveMachine: (machine: Machine) => call<Machine>('saveMachine', { machine }),
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

  open: (req: OpenRequest) => call<{ title: string; tooltip: string; machineId: string }>('open', req),
  bounds: (id: string, r: { x: number; y: number; w: number; h: number }, visible: boolean) => call<void>('bounds', { id, ...r, visible }),
  close: (id: string) => call<void>('close', { id }),
  reconnect: (id: string) => call<void>('reconnect', { id }),
  disconnect: (id: string) => call<void>('disconnect', { id }),
  focus: (id: string) => call<void>('focus', { id }),
  fill: (id: string) => call<void>('fill', { id }),
  fullscreen: (id: string) => call<void>('fullscreen', { id }),
  popout: (id: string) => call<void>('popout', { id }),
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

export const lastUsedMs = (m: Machine) => (m.lastUsed ? Date.parse(m.lastUsed) || 0 : 0);

/** A bare host or IP (optionally :port), for "Remote Desktop to …" quick connect. */
export const RDP_HOST_RE = /^(\d{1,3}(\.\d{1,3}){3}|[a-z0-9][\w-]*(\.[\w-]+)+)(:\d{1,5})?$/i;

// ---------------------------------------------------------------------------
// Covering native windows. An RDP session is a real window above the web
// page, so anything drawn over it (dialogs, menus, drawers) would be hidden
// behind it. Every overlay registers here while open; RDP views then show a
// still picture of the session in its place.

let covers = 0;
const coverSubs = new Set<() => void>();
const notifyCovers = () => coverSubs.forEach((f) => f());

export const cover = {
  push(): () => void {
    covers++;
    notifyCovers();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      covers--;
      notifyCovers();
    };
  },
  get: () => covers > 0,
  subscribe(f: () => void) {
    coverSubs.add(f);
    return () => {
      coverSubs.delete(f);
    };
  },
};

/** Marks the calling overlay as covering native RDP windows while mounted (and `active`). */
export function useCover(active = true) {
  useEffect(() => (active ? cover.push() : undefined), [active]);
}
