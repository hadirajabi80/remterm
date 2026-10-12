import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { BACKGROUNDS, SCHEMES, loadImageFile } from '../themes';
import type { Appearance, LocalShell } from '../types';
import { Icon } from './Icon';

/** Side drawer so changes preview live on the terminal behind it. */
export interface TypingPrefs {
  autosuggest: boolean;
  historyOnUp: boolean;
  defaultShell: string;
  recordLogs: boolean;
}

export function AppearancePanel(props: {
  value: Appearance;
  onChange(a: Appearance): void;
  typing: TypingPrefs;
  onTyping(t: TypingPrefs): void;
  shells: LocalShell[];
  onClose(): void;
}) {
  const a = props.value;
  const set = <K extends keyof Appearance>(k: K, v: Appearance[K]) => props.onChange({ ...a, [k]: v });
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [explorerMenu, setExplorerMenu] = useState<boolean | null>(null);
  useEffect(() => {
    api.explorerMenuEnabled().then(setExplorerMenu).catch(() => setExplorerMenu(false));
  }, []);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const pickImage = async (file?: File) => {
    if (!file) return;
    setError('');
    try {
      const url = await loadImageFile(file);
      props.onChange({ ...a, background: 'custom', customImage: url, dim: Math.max(a.dim, 40) });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const hasBg = a.background !== 'none';

  return (
    <aside className="drawer" role="dialog" aria-label="Appearance">
      <header className="drawer-head">
        <h2>Appearance &amp; typing</h2>
        <button className="icon-btn sm" onClick={props.onClose} aria-label="Close">
          <Icon name="x" size={14} />
        </button>
      </header>
      <div className="drawer-body">
        <section>
          <h3>Background</h3>
          <div className="bg-grid">
            {BACKGROUNDS.map((b) => (
              <button
                key={b.id}
                className={`bg-tile ${a.background === b.id ? 'on' : ''}`}
                onClick={() => set('background', b.id)}
                title={b.name}
              >
                <span className="bg-thumb" style={{ background: b.css || 'var(--term-bg)' }}>
                  {b.id === 'none' && <span className="bg-none">Aa</span>}
                </span>
                <span className="bg-name">{b.name}</span>
              </button>
            ))}
            <button
              className={`bg-tile ${a.background === 'custom' ? 'on' : ''}`}
              onClick={() => (a.customImage ? set('background', 'custom') : fileRef.current?.click())}
              title="Your own image"
            >
              <span
                className="bg-thumb custom"
                style={a.customImage ? { background: `url("${a.customImage}") center / cover` } : undefined}
              >
                {!a.customImage && <Icon name="image" size={20} />}
              </span>
              <span className="bg-name">My image</span>
            </button>
          </div>
          <div className="row-btns">
            <button className="btn sm" onClick={() => fileRef.current?.click()}>
              <Icon name="image" size={13} /> {a.customImage ? 'Change image…' : 'Choose image…'}
            </button>
            {a.customImage && (
              <button
                className="btn sm"
                onClick={() =>
                  props.onChange({ ...a, customImage: '', background: a.background === 'custom' ? 'none' : a.background })
                }
              >
                Remove image
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              void pickImage(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          {error && <div className="error-box">{error}</div>}

          <label className={`slider ${hasBg ? '' : 'disabled'}`}>
            <span>
              Darken <b>{a.dim}%</b>
            </span>
            <input type="range" min={0} max={95} step={5} disabled={!hasBg} value={a.dim} onChange={(e) => set('dim', Number(e.target.value))} />
          </label>
          <label className={`slider ${hasBg ? '' : 'disabled'}`}>
            <span>
              Blur <b>{a.blur}px</b>
            </span>
            <input type="range" min={0} max={24} step={1} disabled={!hasBg} value={a.blur} onChange={(e) => set('blur', Number(e.target.value))} />
          </label>
        </section>

        <section>
          <h3>Color scheme</h3>
          <div className="scheme-grid">
            {SCHEMES.map((s) => {
              const t = s.theme;
              return (
                <button key={s.id} className={`scheme-card ${a.scheme === s.id ? 'on' : ''}`} onClick={() => set('scheme', s.id)}>
                  <span className="scheme-preview" style={{ background: t.background, color: t.foreground }}>
                    <span>
                      <span style={{ color: t.green }}>user@host</span>
                      <span style={{ color: t.blue }}>:~$</span> ls
                    </span>
                    <span className="scheme-dots">
                      {[t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan].map((c, i) => (
                        <i key={i} style={{ background: c }} />
                      ))}
                    </span>
                  </span>
                  <span className="bg-name">{s.name}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <h3>Text</h3>
          <label className="slider">
            <span>
              Font size <b>{a.fontSize}px</b>
            </span>
            <input type="range" min={10} max={24} step={1} value={a.fontSize} onChange={(e) => set('fontSize', Number(e.target.value))} />
          </label>
          <p className="hint">Tip: Ctrl + / Ctrl − / Ctrl 0 change the size from the keyboard.</p>
        </section>

        <section>
          <h3>Local terminal</h3>
          <label className="field">
            Default shell
            <select
              className="input"
              value={props.typing.defaultShell || props.shells[0]?.id || ''}
              onChange={(e) => props.onTyping({ ...props.typing, defaultShell: e.target.value })}
            >
              {props.shells.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              disabled={explorerMenu === null}
              checked={!!explorerMenu}
              onChange={async (e) => {
                const on = e.target.checked;
                try {
                  await api.setExplorerMenu(on);
                  setExplorerMenu(on);
                } catch (err) {
                  setError(errorMessage(err));
                }
              }}
            />
            <span>
              <b>"Open in Termora" in Explorer</b>
              <span className="hint">
                Right-click a folder, a file or empty space in a folder to open a terminal there. On Windows 11 it is under
                "Show more options".
              </span>
            </span>
          </label>
        </section>

        <section>
          <h3>Session logs</h3>
          <label className="toggle">
            <input type="checkbox" checked={props.typing.recordLogs} onChange={(e) => props.onTyping({ ...props.typing, recordLogs: e.target.checked })} />
            <span>
              <b>Record terminal sessions</b>
              <span className="hint">Keeps the last 5 sessions per server (bookmark to keep longer). Hidden password input is never recorded.</span>
            </span>
          </label>
        </section>

        <section>
          <h3>Command history</h3>
          <label className="toggle">
            <input
              type="checkbox"
              checked={props.typing.autosuggest}
              onChange={(e) => props.onTyping({ ...props.typing, autosuggest: e.target.checked })}
            />
            <span>
              <b>Suggest as you type</b>
              <span className="hint">Gray completion from your history. → accepts it, Ctrl+→ one word.</span>
            </span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={props.typing.historyOnUp}
              onChange={(e) => props.onTyping({ ...props.typing, historyOnUp: e.target.checked })}
            />
            <span>
              <b>↑ opens the history list</b>
              <span className="hint">Commands from all servers, this one first. Turn off to use the shell's own ↑.</span>
            </span>
          </label>
        </section>
      </div>
    </aside>
  );
}
