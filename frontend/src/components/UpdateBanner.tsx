import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, openURL, type UpdateInfo } from '../api';
import { useCoverRect } from '../rdp';
import { Icon } from './Icon';

/** "A new version is available" card: downloads, installs and restarts Remterm. */
export function UpdateBanner(props: { info: UpdateInfo; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useCoverRect(ref); // stays visible over a Remote Desktop session
  const [progress, setProgress] = useState<{ pct: number; label: string } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => window.runtime.EventsOn('update:progress', (pct: number, label: string) => setProgress({ pct, label })), []);

  const install = async () => {
    setError('');
    setProgress({ pct: 0, label: 'Downloading…' });
    try {
      await api.installUpdate(); // Remterm quits and the new version starts
    } catch (e) {
      setProgress(null);
      setError(errorMessage(e));
    }
  };

  const notes = props.info.notes
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .slice(0, 3)
    .map((l) => l.slice(2).replace(/\*\*/g, ''));

  return (
    <div className="update-banner" ref={ref} role="status">
      <div className="update-head">
        <span className="update-ico">
          <Icon name="import" size={16} />
        </span>
        <div className="update-title">
          <b>Remterm {props.info.latest} is available</b>
          <span className="hint">You have {props.info.current}</span>
        </div>
        {!progress && (
          <button className="icon-btn sm" title="Later" onClick={props.onClose}>
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
      {notes.length > 0 && !progress && (
        <ul className="update-notes">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {error && <div className="error-box">{error}</div>}
      {progress ? (
        <div className="update-progress">
          <span className="transfer-bar">
            <i style={{ width: `${progress.pct}%` }} />
          </span>
          <span className="hint">
            {progress.label} {progress.pct < 100 ? `${progress.pct}%` : 'Remterm restarts in a moment.'}
          </span>
        </div>
      ) : (
        <div className="row-btns">
          <button className="btn primary sm" onClick={() => void install()}>
            Update now
          </button>
          <button className="btn sm" onClick={() => openURL(props.info.page)}>
            What's new
          </button>
          <button
            className="btn sm"
            onClick={() => {
              try {
                localStorage.setItem('skipVersion', props.info.latest);
              } catch {
                /* ignore */
              }
              props.onClose();
            }}
          >
            Skip this version
          </button>
        </div>
      )}
    </div>
  );
}
