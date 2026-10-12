import { useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { transfers } from '../transfers';
import type { Host } from '../types';
import { formatBytes } from '../util';
import { FilePanel, type PanelState } from './FilePanel';
import { Icon } from './Icon';

/** Two file panes (this PC + a host by default) with a transfers strip. */
export function SftpView(props: {
  hostId: string;
  hosts: Host[];
  auth(target: string, error: string): Promise<{ password: string; save: boolean } | null>;
  notify(text: string, kind?: 'info' | 'error'): void;
}) {
  const [left, setLeft] = useState('local');
  const [right, setRight] = useState(props.hostId);
  const [leftState, setLeftState] = useState<PanelState>({ fsId: null, path: '' });
  const [rightState, setRightState] = useState<PanelState>({ fsId: null, path: '' });
  useSyncExternalStore(transfers.subscribe, transfers.getVersion);
  const list = transfers.list();
  const running = list.filter((t) => t.state === 'running');

  return (
    <div className="sftp-view">
      <div className="sftp-panes">
        <FilePanel source={left} hosts={props.hosts} other={rightState} onSource={setLeft} onState={setLeftState} auth={props.auth} notify={props.notify} />
        <FilePanel source={right} hosts={props.hosts} other={leftState} onSource={setRight} onState={setRightState} auth={props.auth} notify={props.notify} />
      </div>
      {list.length > 0 && (
        <div className="transfers">
          <div className="transfers-head">
            <b>Transfers</b>
            <span className="hint">{running.length ? `${running.length} running` : 'all finished'}</span>
            <span className="spacer" />
            <button className="btn sm" onClick={() => transfers.clearFinished()} disabled={running.length === list.length}>
              Clear finished
            </button>
          </div>
          {list.slice(0, 6).map((t) => {
            const pct = t.bytesTotal ? Math.round((t.bytesDone / t.bytesTotal) * 100) : t.state === 'done' ? 100 : 0;
            return (
              <div key={t.id} className={`transfer ${t.state}`}>
                <span className="transfer-label" title={t.error || t.file}>
                  {t.label}
                  {t.state === 'running' && t.file && t.filesTotal > 1 ? <span className="hint"> · {t.file}</span> : null}
                </span>
                <span className="transfer-bar">
                  <i style={{ width: `${pct}%` }} />
                </span>
                <span className="transfer-meta">
                  {t.state === 'error'
                    ? t.error
                    : t.state === 'canceled'
                      ? 'canceled'
                      : `${formatBytes(t.bytesDone)} / ${formatBytes(t.bytesTotal)}${t.filesTotal > 1 ? ` · ${t.filesDone}/${t.filesTotal} files` : ''}`}
                </span>
                {t.state === 'running' ? (
                  <button className="icon-btn sm" title="Cancel" onClick={() => void api.cancelTransfer(t.id)}>
                    <Icon name="x" size={12} />
                  </button>
                ) : (
                  <span className="transfer-state">{t.state === 'done' ? '✓' : t.state === 'error' ? '!' : '–'}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
