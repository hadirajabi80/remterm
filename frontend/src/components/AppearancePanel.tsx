import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, type UpdateInfo } from '../api';
import { useCover } from '../rdp';
import { BACKGROUNDS, SCHEMES, loadImageFile } from '../themes';
import type { Appearance, LocalShell } from '../types';
import { Icon } from './Icon';

export interface TypingPrefs {
  autosuggest: boolean;
  historyOnUp: boolean;
  defaultShell: string;
  recordLogs: boolean;
}

type Section = 'general' | 'appearance' | 'terminal' | 'rdp' | 'integration';

const SECTIONS: { id: Section; icon: string; label: string; hint: string }[] = [
  { id: 'general', icon: 'gear', label: 'General', hint: 'Theme and updates' },
  { id: 'appearance', icon: 'brush', label: 'Appearance', hint: 'Background, colors, font' },
  { id: 'terminal', icon: 'terminal', label: 'Terminal', hint: 'Shell, history, logs' },
  { id: 'rdp', icon: 'monitor', label: 'Remote Desktop', hint: 'Bastion, logins, display' },
  { id: 'integration', icon: 'folder', label: 'Integration', hint: 'Right-click menu' },
];

const THEMES: { id: NonNullable<Appearance['ui']>; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Same as system' },
];

/** Settings window: a section list on the left, the section on the right. Click outside or Esc closes it. */
export function AppearancePanel(props: {
  value: Appearance;
  onChange(a: Appearance): void;
  typing: TypingPrefs;
  onTyping(t: TypingPrefs): void;
  shells: LocalShell[];
  onRdpSettings?(): void;
  onUpdate?(info: UpdateInfo): void;
  onClose(): void;
}) {
  useCover();
  const a = props.value;
  const set = <K extends keyof Appearance>(k: K, v: Appearance[K]) => props.onChange({ ...a, [k]: v });
  const [section, setSection] = useState<Section>(() => {
    try {
      return (localStorage.getItem('settingsSection') as Section) || 'general';
    } catch {
      return 'general';
    }
  });
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [explorerMenu, setExplorerMenu] = useState<boolean | null>(null);
  const [classic, setClassic] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [classicChanged, setClassicChanged] = useState(false);
  const [platform, setPlatform] = useState('windows');
  const [version, setVersion] = useState('');
  const [updateMsg, setUpdateMsg] = useState('');
  const [autoUpdate, setAutoUpdate] = useState(() => {
    try {
      return localStorage.getItem('autoUpdate') !== 'off';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    api.explorerMenuEnabled().then(setExplorerMenu).catch(() => setExplorerMenu(false));
    api.classicMenu().then(setClassic).catch(() => setClassic(null));
    api.platform().then(setPlatform).catch(() => {});
    api.appVersion().then(setVersion).catch(() => {});
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('settingsSection', section);
    } catch {
      /* ignore */
    }
  }, [section]);

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

  const setTheme = (ui: NonNullable<Appearance['ui']>) => {
    const light = ui === 'light' || (ui === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
    // Follow with the terminal colors when they are still the default ones.
    const scheme = light && a.scheme === 'tokyo' ? 'githublight' : !light && a.scheme === 'githublight' ? 'tokyo' : a.scheme;
    props.onChange({ ...a, ui, scheme });
  };

  const hasBg = a.background !== 'none';
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const fileManager = platform === 'darwin' ? 'Finder' : 'Explorer';

  return (
    <div className="overlay settings-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="settings" role="dialog" aria-label="Settings">
        <nav className="settings-nav">
          <div className="settings-brand">Settings</div>
          {SECTIONS.map((s) => (
            <button key={s.id} className={`settings-tab ${section === s.id ? 'on' : ''}`} onClick={() => setSection(s.id)}>
              <span className="settings-tab-ico">
                <Icon name={s.icon} size={15} />
              </span>
              <span className="settings-tab-text">
                <b>{s.label}</b>
                <span>{s.hint}</span>
              </span>
            </button>
          ))}
          <div className="settings-version">Remterm {version || '…'}</div>
        </nav>

        <div className="settings-main">
          <header className="settings-head">
            <h2>{current.label}</h2>
            <button className="icon-btn sm" onClick={props.onClose} aria-label="Close" title="Close (Esc)">
              <Icon name="x" size={14} />
            </button>
          </header>
          <div className="settings-body">
            {error && <div className="error-box">{error}</div>}

            {section === 'general' && (
              <>
                <div className="set-card">
                  <h3>Theme</h3>
                  <div className="theme-grid">
                    {THEMES.map((t) => (
                      <button key={t.id} className={`theme-card ${(a.ui ?? 'dark') === t.id ? 'on' : ''}`} onClick={() => setTheme(t.id)}>
                        <span className={`theme-preview ${t.id}`}>
                          <i />
                          <i />
                          <i />
                        </span>
                        <span>{t.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="set-card">
                  <h3>Updates</h3>
                  <div className="set-row">
                    <span>
                      <b>Remterm {version || '…'}</b>
                      <span className="hint">{updateMsg || 'Updates come from the GitHub releases.'}</span>
                    </span>
                    <button
                      className="btn sm"
                      onClick={async () => {
                        setUpdateMsg('Checking…');
                        try {
                          const info = await api.checkUpdate();
                          if (info.available) props.onUpdate?.(info);
                          setUpdateMsg(
                            info.available
                              ? `Remterm ${info.latest} is available.`
                              : info.newer
                                ? `Remterm ${info.latest} is out, but its installer for this system is not ready yet. Try again in a few minutes.`
                                : `You have the latest version (${info.current}).`,
                          );
                        } catch (e) {
                          setUpdateMsg(errorMessage(e));
                        }
                      }}
                    >
                      <Icon name="refresh" size={13} /> Check now
                    </button>
                  </div>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={autoUpdate}
                      onChange={(e) => {
                        setAutoUpdate(e.target.checked);
                        try {
                          localStorage.setItem('autoUpdate', e.target.checked ? 'on' : 'off');
                        } catch {
                          /* ignore */
                        }
                      }}
                    />
                    <span>
                      <b>Check for updates when Remterm starts</b>
                      <span className="hint">A new version is installed only when you click Update now.</span>
                    </span>
                  </label>
                </div>
              </>
            )}

            {section === 'appearance' && (
              <>
                <div className="set-card">
                  <h3>Terminal colors</h3>
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
                </div>
                <div className="set-card">
                  <h3>Background</h3>
                  <div className="bg-grid">
                    {BACKGROUNDS.map((b) => (
                      <button key={b.id} className={`bg-tile ${a.background === b.id ? 'on' : ''}`} onClick={() => set('background', b.id)} title={b.name}>
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
                      <span className="bg-thumb custom" style={a.customImage ? { background: `url("${a.customImage}") center / cover` } : undefined}>
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
                      <button className="btn sm" onClick={() => props.onChange({ ...a, customImage: '', background: a.background === 'custom' ? 'none' : a.background })}>
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
                  <div className="set-two">
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
                  </div>
                </div>
                <div className="set-card">
                  <h3>Text</h3>
                  <label className="slider">
                    <span>
                      Font size <b>{a.fontSize}px</b>
                    </span>
                    <input type="range" min={10} max={24} step={1} value={a.fontSize} onChange={(e) => set('fontSize', Number(e.target.value))} />
                  </label>
                  <p className="hint">Ctrl + / Ctrl − / Ctrl 0 change it from the keyboard.</p>
                </div>
              </>
            )}

            {section === 'terminal' && (
              <>
                <div className="set-card">
                  <h3>Local terminal</h3>
                  <label className="field">
                    Default shell
                    <select className="input" value={props.typing.defaultShell || props.shells[0]?.id || ''} onChange={(e) => props.onTyping({ ...props.typing, defaultShell: e.target.value })}>
                      {props.shells.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="set-card">
                  <h3>Command history</h3>
                  <label className="toggle">
                    <input type="checkbox" checked={props.typing.autosuggest} onChange={(e) => props.onTyping({ ...props.typing, autosuggest: e.target.checked })} />
                    <span>
                      <b>Suggest as you type</b>
                      <span className="hint">Gray completion from your history. → accepts it, Ctrl+→ one word.</span>
                    </span>
                  </label>
                  <label className="toggle">
                    <input type="checkbox" checked={props.typing.historyOnUp} onChange={(e) => props.onTyping({ ...props.typing, historyOnUp: e.target.checked })} />
                    <span>
                      <b>↑ opens the history list</b>
                      <span className="hint">Commands from all servers, this one first. Turn off to use the shell's own ↑.</span>
                    </span>
                  </label>
                </div>
                <div className="set-card">
                  <h3>Session logs</h3>
                  <label className="toggle">
                    <input type="checkbox" checked={props.typing.recordLogs} onChange={(e) => props.onTyping({ ...props.typing, recordLogs: e.target.checked })} />
                    <span>
                      <b>Record terminal sessions</b>
                      <span className="hint">Keeps the last 5 sessions per server (bookmark to keep longer). Hidden password input is never recorded.</span>
                    </span>
                  </label>
                </div>
              </>
            )}

            {section === 'rdp' && (
              <div className="set-card">
                <h3>Remote Desktop</h3>
                <p className="hint">
                  The WALLIX bastion (address, user name, password), saved logins, filling logins automatically, display and devices, and the master
                  password.
                </p>
                {props.onRdpSettings ? (
                  <button className="btn primary" onClick={props.onRdpSettings}>
                    <Icon name="monitor" size={14} /> Open Remote Desktop settings
                  </button>
                ) : (
                  <p className="hint">Remote Desktop is still starting.</p>
                )}
                <p className="hint">The machine list is in the sidebar: the monitor icon.</p>
              </div>
            )}

            {section === 'integration' && (
              <div className="set-card">
                <h3>Right-click menu</h3>
                {platform !== 'linux' && (
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
                      <b>"Open in Remterm" in {fileManager}</b>
                      <span className="hint">
                        {platform === 'darwin'
                          ? 'Right-click a folder → Quick Actions → Open in Remterm. You can also drop a folder on the Dock icon.'
                          : 'Right-click a folder, a file or empty space in a folder to open a terminal there.'}
                      </span>
                    </span>
                  </label>
                )}
                {classic?.supported && (
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={classic.enabled}
                      onChange={async (e) => {
                        const on = e.target.checked;
                        try {
                          await api.setClassicMenu(on);
                          setClassic({ ...classic, enabled: on });
                          setClassicChanged(true);
                        } catch (err) {
                          setError(errorMessage(err));
                        }
                      }}
                    />
                    <span>
                      <b>Full right-click menu (Windows 11)</b>
                      <span className="hint">Windows 11's short menu hides "Open in Remterm" under "Show more options". This brings back the full menu for your account.</span>
                      {classicChanged && (
                        <button
                          className="btn sm"
                          style={{ marginTop: 6 }}
                          onClick={() => void api.restartExplorer().then(() => setClassicChanged(false)).catch((err) => setError(errorMessage(err)))}
                        >
                          Restart Explorer to apply
                        </button>
                      )}
                    </span>
                  </label>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
