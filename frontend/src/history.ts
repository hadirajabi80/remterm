import { api } from './api';

export interface CmdEntry {
  command: string;
  hostKey: string; // 'ssh:<hostId>' | 'spec:<user@host>' | 'local:<shellId>'
  count: number;
  lastUsed: number;
}

/** One command across hosts, as shown in the history list. */
export interface HistoryItem {
  command: string;
  lastUsed: number;
  count: number;
  here: boolean; // ran on the current pane's host
  hostKeys: string[];
}

// Mirrors the backend filter: credentials-looking commands are never stored,
// and a leading space means "don't record" (shell convention).
const SECRET_RE = /(pass(word|wd)?|secret|token|api[_-]?key)\s*[=:]\s*\S|--?(password|passwd|token|secret)[=\s]\S/i;

export function isRecordable(cmd: string): boolean {
  const t = cmd.trim();
  return t.length > 0 && t.length <= 2000 && !cmd.startsWith(' ') && !SECRET_RE.test(t);
}

/** User preferences read by terminals while typing. */
export const typingPrefs = { autosuggest: true, historyOnUp: true, defaultShell: '' };

class HistoryStore {
  private entries: CmdEntry[] = [];
  private listeners = new Set<() => void>();
  version = 0;

  async load() {
    this.entries = await api.listCommandHistory();
    this.changed();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getVersion = () => this.version;

  private changed() {
    this.version++;
    this.listeners.forEach((f) => f());
  }

  add(command: string, hostKey: string) {
    if (!isRecordable(command)) return;
    const cmd = command.trim();
    const now = Date.now();
    const e = this.entries.find((x) => x.command === cmd && x.hostKey === hostKey);
    if (e) {
      e.count++;
      e.lastUsed = now;
    } else {
      this.entries.push({ command: cmd, hostKey, count: 1, lastUsed: now });
    }
    this.changed();
    api.addCommandHistory(cmd, hostKey).catch(() => {});
  }

  remove(command: string) {
    this.entries = this.entries.filter((e) => e.command !== command);
    this.changed();
    api.deleteCommandHistory(command).catch(() => {});
  }

  clear() {
    this.entries = [];
    this.changed();
    api.clearCommandHistory().catch(() => {});
  }

  /** Best completion for what is typed: same host first, then recency with a bonus for frequent use. */
  suggest(prefix: string, hostKey: string): string | null {
    if (!prefix.trim()) return null;
    let best: CmdEntry | null = null;
    let bestScore = -Infinity;
    for (const e of this.entries) {
      if (e.command.length <= prefix.length || !e.command.startsWith(prefix)) continue;
      const score = (e.hostKey === hostKey ? 1e13 : 0) + e.lastUsed + Math.min(e.count, 50) * 3_600_000;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best?.command ?? null;
  }

  /**
   * Commands matching every word of the query, deduplicated, oldest first so
   * the newest sits next to the prompt. Commands from this host come last
   * (closest to the prompt), other hosts above them.
   */
  search(query: string, hostKey: string, limit = 300): HistoryItem[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const byCmd = new Map<string, HistoryItem>();
    for (const e of this.entries) {
      const lc = e.command.toLowerCase();
      if (!words.every((w) => lc.includes(w))) continue;
      const it = byCmd.get(e.command);
      if (it) {
        it.count += e.count;
        it.lastUsed = Math.max(it.lastUsed, e.lastUsed);
        it.here ||= e.hostKey === hostKey;
        it.hostKeys.push(e.hostKey);
      } else {
        byCmd.set(e.command, {
          command: e.command,
          lastUsed: e.lastUsed,
          count: e.count,
          here: e.hostKey === hostKey,
          hostKeys: [e.hostKey],
        });
      }
    }
    const items = [...byCmd.values()].sort((a, b) => Number(a.here) - Number(b.here) || a.lastUsed - b.lastUsed);
    return items.slice(-limit);
  }

  /** Newest first, for the sidebar. */
  recent(query: string, limit = 500): HistoryItem[] {
    return this.search(query, '', 100000)
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .slice(0, limit);
  }
}

export const history = new HistoryStore();
