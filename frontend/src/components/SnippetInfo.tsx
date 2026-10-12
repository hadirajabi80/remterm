import type { Snippet } from '../types';
import { commandParts, snippetVars } from '../util';
import { Icon } from './Icon';

/** Command text with {{placeholders}} rendered as chips. */
export function CommandView({ command }: { command: string }) {
  return (
    <code className="cmd-view">
      {commandParts(command).map((p, i) =>
        p.varName ? (
          <span key={i} className="var-chip">
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </code>
  );
}

/** Details card for the selected snippet at the bottom of the sidebar. */
export function SnippetInfo(props: {
  snippet: Snippet;
  canRun: boolean;
  onRun(execute: boolean): void;
  onEdit(): void;
  onClose(): void;
}) {
  const s = props.snippet;
  const vars = snippetVars(s.command);
  return (
    <div className="snippet-info">
      <div className="si-head">
        <span className="si-group">{s.group || 'General'}</span>
        <button className="icon-btn sm" title="Close" onClick={props.onClose}>
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="si-name">{s.name}</div>
      {s.description && <p className="si-desc">{s.description}</p>}
      <CommandView command={s.command} />
      {vars.length > 0 && (
        <div className="si-vars">
          You will be asked for: {vars.map((v) => (v.def ? `${v.name} (default ${v.def})` : v.name)).join(', ')}
        </div>
      )}
      <div className="si-actions">
        <button className="btn primary sm" disabled={!props.canRun} onClick={() => props.onRun(true)} title="Send with Enter">
          <Icon name="play" size={12} /> Run
        </button>
        <button className="btn sm" disabled={!props.canRun} onClick={() => props.onRun(false)} title="Type it without pressing Enter">
          <Icon name="insert" size={13} /> Insert
        </button>
        <button className="btn sm" onClick={props.onEdit}>
          <Icon name="edit" size={13} /> Edit
        </button>
      </div>
      {!props.canRun && <div className="si-hint">Open a connection to run this snippet.</div>}
    </div>
  );
}
