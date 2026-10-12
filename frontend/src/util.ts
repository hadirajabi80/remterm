import type { Host } from './types';

export const ENVS = [
  { value: '', label: 'None' },
  { value: 'dev', label: 'Development' },
  { value: 'staging', label: 'Staging' },
  { value: 'prod', label: 'Production' },
];

export const ENV_SHORT: Record<string, string> = { dev: 'DEV', staging: 'STAGING', prod: 'PROD' };

export function hostLabel(h: Pick<Host, 'user' | 'address' | 'port'>): string {
  return `${h.user ? h.user + '@' : ''}${h.address}${h.port && h.port !== 22 ? ':' + h.port : ''}`;
}

/** Most recently used first, then never-used hosts by name. */
export function byRecent(hosts: Host[]): Host[] {
  return [...hosts].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || a.name.localeCompare(b.name));
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function groupBy<T>(items: T[], key: (t: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  // Named groups alphabetically, the unnamed group last.
  return [...m.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
}

export function matches(query: string, ...fields: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fields.join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

export const SPEC_RE = /^(ssh\s+)?([^@\s]+@)?(\[[0-9a-f:]+\]|[\w.-]+)(:\d{1,5})?$/i;

export function looksLikeSpec(q: string): boolean {
  const s = q.trim();
  return SPEC_RE.test(s) && (s.includes('@') || s.includes('.') || s.includes(':'));
}

// ---- snippet placeholders: {{name}} or {{name:default}} ----
// Names must start with a letter, so Docker/Go templates like {{.Names}} or
// {{json .State}} are left untouched.
const VAR_RE = /\{\{([A-Za-z][\w-]*)(?::([^{}]*))?\}\}/g;

export interface SnippetVar {
  name: string;
  def: string;
}

export function snippetVars(command: string): SnippetVar[] {
  const seen = new Map<string, SnippetVar>();
  for (const m of command.matchAll(VAR_RE)) {
    const v = seen.get(m[1]);
    if (!v) seen.set(m[1], { name: m[1], def: m[2] ?? '' });
    else if (!v.def && m[2]) v.def = m[2];
  }
  return [...seen.values()];
}

export function fillVars(command: string, values: Record<string, string>): string {
  return command.replace(VAR_RE, (_all, name: string) => values[name] ?? '');
}

/** Splits a command into plain text and placeholder parts for highlighting. */
export function commandParts(command: string): { text: string; varName?: string }[] {
  const parts: { text: string; varName?: string }[] = [];
  let last = 0;
  for (const m of command.matchAll(VAR_RE)) {
    if (m.index! > last) parts.push({ text: command.slice(last, m.index) });
    parts.push({ text: m[1], varName: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < command.length) parts.push({ text: command.slice(last) });
  return parts;
}

const VAR_KEY = 'snippetVar:';

export function rememberedVar(name: string): string | null {
  try {
    return localStorage.getItem(VAR_KEY + name);
  } catch {
    return null;
  }
}

export function rememberVar(name: string, value: string) {
  try {
    localStorage.setItem(VAR_KEY + name, value);
  } catch {
    /* storage unavailable */
  }
}

// ---- groups ----

export interface GroupNode {
  path: string; // "" for the root
  name: string;
  children: GroupNode[];
  hosts: Host[];
  total: number; // hosts in this group and below
}

/** Nested group tree from "A/B/C" group paths (plus groups that only exist as settings). */
export function buildGroupTree(hosts: Host[], groupPaths: string[]): GroupNode {
  const root: GroupNode = { path: '', name: '', children: [], hosts: [], total: 0 };
  const nodeFor = (path: string): GroupNode => {
    if (!path) return root;
    let node = root;
    let acc = '';
    for (const part of path.split('/').filter(Boolean)) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.find((c) => c.path === acc);
      if (!child) {
        child = { path: acc, name: part, children: [], hosts: [], total: 0 };
        node.children.push(child);
      }
      node = child;
    }
    return node;
  };
  for (const g of groupPaths) nodeFor(g);
  for (const h of hosts) nodeFor(h.group.replace(/^\/+|\/+$/g, '')).hosts.push(h);
  const finish = (n: GroupNode): number => {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.hosts.sort((a, b) => a.name.localeCompare(b.name));
    n.total = n.hosts.length + n.children.reduce((s, c) => s + finish(c), 0);
    return n.total;
  };
  finish(root);
  return root;
}

export function hostsInGroup(hosts: Host[], path: string): Host[] {
  return hosts.filter((h) => h.group === path || h.group.startsWith(path + '/'));
}

/** Nearest setting from the host, then its groups (deepest first). */
export function inherited<K extends 'scheme' | 'identityId' | 'jumpHostId'>(
  host: Host,
  groups: { path: string; scheme: string; identityId: string; jumpHostId: string }[],
  key: K,
): string {
  if (host[key]) return host[key];
  const parts = host.group.split('/').filter(Boolean);
  for (let i = parts.length; i > 0; i--) {
    const g = groups.find((x) => x.path === parts.slice(0, i).join('/'));
    if (g?.[key]) return g[key];
  }
  return '';
}

// ---- formatting ----

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    year: sameYear ? undefined : 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function octal(perm: number): string {
  return (perm & 0o777).toString(8).padStart(3, '0');
}

export const PROTOCOLS = [
  { value: 'ssh', label: 'SSH' },
  { value: 'telnet', label: 'Telnet' },
  { value: 'serial', label: 'Serial' },
];
