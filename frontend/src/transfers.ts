import { api, events } from './api';
import type { TransferProgress } from './types';

export interface TransferInfo extends TransferProgress {
  srcFs: string;
  dstFs: string;
  dstDir: string;
  started: number;
}

type DoneListener = (dstFs: string, dstDir: string) => void;

/** All file transfers, shared by every SFTP view. */
class TransferStore {
  private items = new Map<string, TransferInfo>();
  private listeners = new Set<() => void>();
  private doneListeners = new Set<DoneListener>();
  private wired = false;
  version = 0;

  private wire() {
    if (this.wired) return;
    this.wired = true;
    events.transfer((p) => {
      const t = this.items.get(p.id);
      if (!t) return;
      Object.assign(t, p);
      if (p.state === 'done') this.doneListeners.forEach((f) => f(t.dstFs, t.dstDir));
      this.changed();
    });
  }

  subscribe = (fn: () => void) => {
    this.wire();
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getVersion = () => this.version;

  /** Called when a transfer finishes, so panes showing the target folder refresh. */
  onDone(fn: DoneListener) {
    this.wire();
    this.doneListeners.add(fn);
    return () => {
      this.doneListeners.delete(fn);
    };
  }

  private changed() {
    this.version++;
    this.listeners.forEach((f) => f());
  }

  async start(srcFs: string, paths: string[], dstFs: string, dstDir: string) {
    this.wire();
    const id = await api.fsTransfer({ srcFs, paths, dstFs, dstDir });
    if (!this.items.has(id)) {
      this.items.set(id, {
        id,
        state: 'running',
        label: paths.length === 1 ? (paths[0].split(/[\\/]/).pop() ?? '') : `${paths.length} items`,
        file: '',
        filesDone: 0,
        filesTotal: 0,
        bytesDone: 0,
        bytesTotal: 0,
        error: '',
        srcFs,
        dstFs,
        dstDir,
        started: Date.now(),
      });
      this.changed();
    }
    return id;
  }

  list(): TransferInfo[] {
    return [...this.items.values()].sort((a, b) => b.started - a.started);
  }

  clearFinished() {
    for (const [id, t] of this.items) if (t.state !== 'running') this.items.delete(id);
    this.changed();
  }
}

export const transfers = new TransferStore();
