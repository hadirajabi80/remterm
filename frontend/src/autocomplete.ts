import type { Terminal } from '@xterm/xterm';
import { history, typingPrefs } from './history';

// Prompt endings: "user@host:~$ ", "root# ", "PS C:\x> ", "C:\x>", "❯ ".
const PROMPT_RE = /^.*?(?:PS [^>\n]*>|[$#%❯›»>])\s?(.+)$/;

export function extractAfterPrompt(line: string): string | null {
  const m = line.trimEnd().match(PROMPT_RE);
  const cmd = m?.[1]?.trim();
  return cmd ? cmd : null;
}

export interface CursorAnchor {
  left: number;
  top: number;
  bottom: number;
}

/**
 * Follows what the user types on the current shell line to
 *  - record finished commands in history,
 *  - show an inline suggestion (gray "ghost" text) from history,
 *  - tell whether ↑ may open the history list.
 *
 * The typed line is only trusted while it is "clean" (built from plain
 * characters and backspace). Arrow keys, Tab and other control keys let
 * the shell edit the line, so the tracker falls back to reading the screen.
 * A command is recorded only if it is visible on screen, which keeps
 * passwords typed at no-echo prompts out of history.
 */
export class LineTracker {
  buffer = '';
  private clean = true;
  private ghost?: HTMLDivElement;
  private ghostText = '';
  private raf = 0;

  constructor(
    private readonly term: Terminal,
    private readonly hostKey: () => string,
    private readonly send: (data: string) => void,
  ) {
    const schedule = () => this.schedule();
    term.onWriteParsed(schedule);
    term.onCursorMove(schedule);
    term.onScroll(schedule);
    term.onResize(schedule);
  }

  private get inShell() {
    return this.term.buffer.active.type === 'normal';
  }

  reset() {
    this.buffer = '';
    this.clean = true;
    this.hideGhost();
  }

  /** Everything sent to the shell passes through here (typing, paste, snippets). */
  onSend(data: string) {
    if (!this.inShell) {
      this.reset();
      return;
    }
    const s = data.replace(/\x1b\[20[01]~/g, ''); // bracketed-paste markers
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\r' || ch === '\n') {
        this.commit();
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.clean) this.buffer = this.buffer.slice(0, -1);
      } else if (ch === '\x03' || ch === '\x15') {
        this.reset(); // Ctrl+C / Ctrl+U clear the line
      } else if (ch === '\x1b') {
        this.clean = false;
        if (s[i + 1] === '[') {
          i += 2;
          while (i < s.length && !(s.charCodeAt(i) >= 0x40 && s.charCodeAt(i) <= 0x7e)) i++;
        } else if (s[i + 1] === 'O') {
          i += 2;
        } else {
          i += 1;
        }
      } else if (ch < ' ') {
        this.clean = false; // Tab completion, Ctrl+A/W/…: the shell owns the line now
      } else if (this.clean) {
        this.buffer += ch;
      }
    }
    this.schedule();
  }

  private commit() {
    const typed = this.buffer;
    const clean = this.clean;
    this.buffer = '';
    this.clean = true;
    this.hideGhost();

    const b = this.term.buffer.active;
    const row = b.baseY + b.cursorY;
    const key = this.hostKey();
    if (!clean) {
      const cmd = extractAfterPrompt(this.lineText(row));
      if (cmd) history.add(cmd, key);
      return;
    }
    if (!typed.trim()) return;
    if (this.lineText(row).trimEnd().endsWith(typed.trimEnd())) {
      history.add(typed, key);
      return;
    }
    // Echo has not arrived yet (paste, snippet, slow link) — or it never will
    // (password prompt). Check the same screen row again shortly.
    const check = (attempt: number) =>
      window.setTimeout(
        () => {
          if (this.lineText(row).includes(typed.trim())) history.add(typed, key);
          else if (attempt < 2) check(attempt + 1);
        },
        attempt === 0 ? 400 : 1500,
      );
    check(0);
  }

  /** Text of a logical line (joining soft-wrapped rows). */
  private lineText(row: number, upToCursor = false): string {
    const b = this.term.buffer.active;
    let start = row;
    while (start > 0 && b.getLine(start)?.isWrapped) start--;
    let end = row;
    if (!upToCursor) while (b.getLine(end + 1)?.isWrapped) end++;
    let s = '';
    for (let r = start; r <= end; r++) {
      const text = b.getLine(r)?.translateToString(r === end && !upToCursor) ?? '';
      s += upToCursor && r === row ? text.slice(0, b.cursorX) : text;
    }
    return s;
  }

  /** True when the cursor sits at the end of the line we are tracking (a shell prompt). */
  private atTrackedLineEnd(): boolean {
    if (!this.inShell || !this.clean) return false;
    const b = this.term.buffer.active;
    if (b.viewportY !== b.baseY) return false;
    const row = b.baseY + b.cursorY;
    const after = (b.getLine(row)?.translateToString(true) ?? '').slice(b.cursorX);
    if (after.trim() !== '') return false; // text after the cursor, e.g. a shell's own suggestion
    return this.lineText(row, true).endsWith(this.buffer);
  }

  canOpenHistory(): boolean {
    return typingPrefs.historyOnUp && this.atTrackedLineEnd();
  }

  /** Screen position of the cursor, for placing the history list. */
  cursorAnchor(): CursorAnchor | null {
    const screen = this.term.element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen) return null;
    const r = screen.getBoundingClientRect();
    const cw = r.width / this.term.cols;
    const ch = r.height / this.term.rows;
    const b = this.term.buffer.active;
    return { left: r.left + b.cursorX * cw, top: r.top + b.cursorY * ch, bottom: r.top + (b.cursorY + 1) * ch };
  }

  /** Replaces the typed line with a command from history. */
  replaceLine(command: string, run: boolean) {
    this.send('\x7f'.repeat(this.buffer.length) + command + (run ? '\r' : ''));
  }

  /** Accepts the gray suggestion (or just its next word). */
  accept(wordOnly: boolean): boolean {
    if (!this.ghostText || !this.ghost || this.ghost.style.display === 'none') return false;
    let text = this.ghostText;
    if (wordOnly) text = text.match(/^\s*\S+/)?.[0] ?? text;
    this.send(text);
    return true;
  }

  // ---- ghost text ----

  private schedule() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.updateGhost());
  }

  private updateGhost() {
    if (!typingPrefs.autosuggest || !this.buffer || !this.atTrackedLineEnd()) return this.hideGhost();
    const suggestion = history.suggest(this.buffer, this.hostKey());
    if (!suggestion) return this.hideGhost();
    this.ghostText = suggestion.slice(this.buffer.length);
    this.showGhost();
  }

  private showGhost() {
    const screen = this.term.element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen) return;
    if (!this.ghost || this.ghost.parentElement !== screen) {
      this.ghost = document.createElement('div');
      this.ghost.className = 'ghost-text';
      screen.appendChild(this.ghost);
    }
    const b = this.term.buffer.active;
    const cw = screen.clientWidth / this.term.cols;
    const ch = screen.clientHeight / this.term.rows;
    const room = Math.max(0, this.term.cols - b.cursorX - 1);
    const visible = this.ghostText.slice(0, room);
    const g = this.ghost;
    g.style.display = visible ? 'block' : 'none';
    g.style.left = `${b.cursorX * cw}px`;
    g.style.top = `${b.cursorY * ch}px`;
    g.style.height = `${ch}px`;
    g.style.lineHeight = `${ch}px`;
    g.style.fontSize = `${this.term.options.fontSize}px`;
    g.style.fontFamily = this.term.options.fontFamily ?? 'monospace';
    g.style.color = this.term.options.theme?.brightBlack ?? '#6b778a';
    // One fixed-width cell per character so the text lines up with the grid.
    g.replaceChildren(
      ...[...visible].map((c) => {
        const span = document.createElement('span');
        span.textContent = c;
        span.style.width = `${cw}px`;
        return span;
      }),
    );
  }

  private hideGhost() {
    this.ghostText = '';
    if (this.ghost) this.ghost.style.display = 'none';
  }
}
