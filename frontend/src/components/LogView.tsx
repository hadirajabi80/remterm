import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { api, cleanError, errorMessage } from '../api';
import { formatBytes, formatDate } from '../util';
import type { LogEntry } from '../types';
import { Icon } from './Icon';

/** Replays a recorded session (colors included) in a read-only terminal. */
export function LogView(props: { logId: string; theme: ITheme; fontSize: number; notify(text: string, kind?: 'info' | 'error'): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<SearchAddon>();
  const [entry, setEntry] = useState<LogEntry | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      scrollback: 200000,
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: props.fontSize,
      theme: props.theme,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    searchRef.current = search;
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(ref.current!);
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    });
    ro.observe(ref.current!);
    api
      .readLog(props.logId)
      .then((b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        term.write(bytes);
      })
      .catch((e) => setError(cleanError(errorMessage(e))));
    api.listLogs().then((all) => setEntry(all.find((l) => l.id === props.logId) ?? null));
    return () => {
      ro.disconnect();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.logId]);

  return (
    <div className="log-view">
      <div className="log-head">
        <Icon name="terminal" size={14} />
        <b>{entry?.title ?? 'Session log'}</b>
        {entry && (
          <span className="hint">
            {formatDate(entry.started)} · {formatBytes(entry.size)}
            {entry.bookmarked ? ' · ★ bookmarked' : ''}
            {entry.comment ? ` — ${entry.comment}` : ''}
          </span>
        )}
        <span className="spacer" />
        <form
          className="log-search"
          onSubmit={(e) => {
            e.preventDefault();
            searchRef.current?.findNext(query);
          }}
        >
          <Icon name="search" size={13} />
          <input placeholder="Find in log" value={query} onChange={(e) => setQuery(e.target.value)} />
        </form>
        <button
          className="btn sm"
          onClick={() =>
            api
              .exportLog(props.logId)
              .then((p) => p && props.notify(`Saved ${p}`))
              .catch((e) => props.notify(errorMessage(e), 'error'))
          }
        >
          Export .txt
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="log-term" ref={ref} />
    </div>
  );
}
