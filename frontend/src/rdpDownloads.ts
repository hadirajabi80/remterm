export const RDP_DOWNLOAD_CHUNK_BYTES = 256 * 1024;

/** Owns generation, clipboard-list identity, and the one-transfer-at-a-time reservation. */
export class RdpDownloadLifecycle<T> {
  private generation = 0;
  private files: T | null = null;
  private busy = false;

  start(): number {
    this.generation++;
    this.files = null;
    this.busy = false;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  publishFiles(generation: number, files: T): boolean {
    if (!this.isCurrent(generation)) return false;
    this.files = files;
    return true;
  }

  currentFiles(generation: number): T | null {
    return this.isCurrent(generation) ? this.files : null;
  }

  reserve(generation: number, files: T): boolean {
    if (!this.isCurrent(generation) || this.files !== files || this.busy) return false;
    this.busy = true;
    return true;
  }

  release(generation: number): void {
    if (this.isCurrent(generation)) this.busy = false;
  }

  end(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.generation++;
    this.files = null;
    this.busy = false;
    return true;
  }
}

/**
 * Watches the active remote download for inactivity: the provider has no cancel or
 * timeout of its own, so every progress event re-arms the timer and one silent
 * period fires `onStall` (which must dispose the session's provider).
 */
export class RdpStallGuard {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cleared = false;

  constructor(
    private readonly stallMs: number,
    private readonly onStall: () => void,
  ) {}

  /** (Re)arm on download progress; a cleared guard ignores stale progress events. */
  activity(): void {
    if (this.cleared) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onStall();
    }, this.stallMs);
  }

  /** Stop watching: transfer completed, failed, or the session is ending. */
  clear(): void {
    this.cleared = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export interface RdpDownloadBridge {
  write(id: string, chunkBase64: string): Promise<void>;
  finish(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
}

/** Stream a blob to the native staging file without materializing its whole base64 form. */
export async function streamRdpDownload(
  blob: Blob,
  id: string,
  bridge: RdpDownloadBridge,
  isCurrent: () => boolean,
  onBytes: (bytes: number) => void,
): Promise<void> {
  try {
    for (let offset = 0; offset < blob.size; offset += RDP_DOWNLOAD_CHUNK_BYTES) {
      if (!isCurrent()) throw new Error('The RDP session ended during the download.');
      const bytes = new Uint8Array(await blob.slice(offset, offset + RDP_DOWNLOAD_CHUNK_BYTES).arrayBuffer());
      if (!isCurrent()) throw new Error('The RDP session ended during the download.');
      await bridge.write(id, toBase64(bytes));
      if (!isCurrent()) throw new Error('The RDP session ended during the download.');
      onBytes(bytes.byteLength);
    }
    if (!isCurrent()) throw new Error('The RDP session ended during the download.');
    await bridge.finish(id);
  } catch (error) {
    await bridge.cancel(id).catch(() => {});
    throw error;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // Avoid argument-count limits from spreading a 256 KiB chunk into fromCharCode.
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}
