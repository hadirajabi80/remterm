import type { Pane } from '../types';
import { ENV_SHORT } from '../util';

const STATUS_LABEL: Record<Pane['status'], string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
};

export function StatusBar(props: {
  pane?: Pane;
  paneCount: number;
  zoomed: boolean;
  broadcast: boolean;
  hostCount: number;
  fontSize: number;
  version?: string;
}) {
  const { pane } = props;
  const version = props.version && (
    <span className="st-version" title="Remterm version (Settings → General to update)">
      {/^\d/.test(props.version) ? `v${props.version}` : props.version}
    </span>
  );
  if (!pane) {
    return (
      <footer className="statusbar">
        <span>Ready</span>
        <span>{props.hostCount} saved hosts</span>
        <span className="spacer" />
        <span>Ctrl+Shift+P for commands</span>
        {version}
      </footer>
    );
  }
  const local = pane.target.kind === 'local';
  const isRdp = pane.target.kind === 'rdp';
  const lat = pane.latency;
  const latClass = lat === undefined ? '' : lat < 80 ? 'good' : lat < 200 ? 'warn' : 'bad';
  return (
    <footer className="statusbar">
      {local ? <span className="badge local">LOCAL</span> : isRdp ? <span className="badge rdp">RDP</span> : pane.env && <span className={`badge ${pane.env}`}>{ENV_SHORT[pane.env] ?? pane.env}</span>}
      {props.broadcast && props.paneCount > 1 && <span className="badge broadcast">BROADCAST · {props.paneCount} panes</span>}
      <span className="st-status">
        <span className={`sdot ${pane.status}`} />
        {local && pane.status === 'connected' ? 'Running' : STATUS_LABEL[pane.status]}
      </span>
      <span className="mono">{local ? pane.title : pane.subtitle}</span>
      {!local && pane.status === 'connected' && lat !== undefined && <span className={`latency ${latClass}`}>{lat} ms</span>}
      {pane.status !== 'connected' && pane.message && <span className="st-msg">{pane.message.split('\n')[0]}</span>}
      <span className="spacer" />
      {props.paneCount > 1 && (
        <span>
          {props.paneCount} panes{props.zoomed ? ' · zoomed' : ''}
        </span>
      )}
      {pane.cols && pane.rows && (
        <span className="mono">
          {pane.cols}×{pane.rows}
        </span>
      )}
      {isRdp ? (
        <span>{pane.rdpMode === 'window' ? 'own window' : pane.rdpMode === 'fullscreen' ? 'fullscreen' : 'Ctrl+Alt+K fill login'}</span>
      ) : (
        <>
          <span>UTF-8</span>
          <span>{props.fontSize}px</span>
        </>
      )}
      {version}
    </footer>
  );
}
