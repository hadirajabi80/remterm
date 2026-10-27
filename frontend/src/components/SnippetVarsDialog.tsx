import { useState } from 'react';
import type { Snippet } from '../types';
import { fillVars, rememberVar, rememberedVar, snippetVars } from '../util';
import { Modal } from './Modal';

/** Asks for the {{placeholder}} values of a snippet before sending it. */
export function SnippetVarsDialog(props: {
  snippet: Snippet;
  execute: boolean;
  onSubmit(command: string): void;
  onCancel(): void;
}) {
  const vars = snippetVars(props.snippet.command);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(vars.map((v) => [v.name, rememberedVar(v.name) ?? v.def])),
  );
  const preview = fillVars(props.snippet.command, values);
  // {{name}} needs a value; only {{name:default}} may be left empty.
  const missing = new Set(vars.filter((v) => !v.optional && !(values[v.name] ?? '').trim()).map((v) => v.name));

  return (
    <Modal
      title={props.snippet.name}
      onClose={props.onCancel}
      width={520}
      footer={
        <>
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn primary" type="submit" form="vars-form" disabled={missing.size > 0}>
            {props.execute ? 'Run' : 'Insert'}
          </button>
        </>
      }
    >
      <form
        id="vars-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (missing.size) return;
          for (const v of vars) rememberVar(v.name, values[v.name] ?? '');
          props.onSubmit(preview);
        }}
      >
        {props.snippet.description && <p className="muted-text">{props.snippet.description}</p>}
        {vars.map((v, i) => (
          <label key={v.name} className="field">
            <span>
              {v.name} {v.def && <span className="hint">— default {v.def}</span>}
              {missing.has(v.name) && <span className="hint"> — required</span>}
            </span>
            <input
              className="input mono"
              autoFocus={i === 0}
              spellCheck={false}
              value={values[v.name] ?? ''}
              placeholder={v.def || v.name}
              onChange={(e) => setValues((p) => ({ ...p, [v.name]: e.target.value }))}
            />
          </label>
        ))}
        <div className="field">
          Command
          <code className="cmd-view">{preview}</code>
        </div>
      </form>
    </Modal>
  );
}
