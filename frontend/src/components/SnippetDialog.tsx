import { useState } from 'react';
import { errorMessage } from '../api';
import type { Snippet } from '../types';
import { Modal } from './Modal';

export function SnippetDialog(props: {
  snippet: Snippet | null;
  groups: string[];
  onSave(s: Snippet): Promise<void>;
  onClose(): void;
}) {
  const [s, setS] = useState<Snippet>(props.snippet ?? { id: '', name: '', group: '', command: '', description: '' });
  const [error, setError] = useState('');
  const set = <K extends keyof Snippet>(k: K, v: Snippet[K]) => setS((p) => ({ ...p, [k]: v }));

  return (
    <Modal
      title={props.snippet ? 'Edit snippet' : 'New snippet'}
      onClose={props.onClose}
      width={540}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" type="submit" form="snippet-form">
            Save
          </button>
        </>
      }
    >
      <form
        id="snippet-form"
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await props.onSave(s);
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        {error && <div className="error-box span2">{error}</div>}
        <label className="field">
          Name
          <input className="input" autoFocus placeholder="Restart API" value={s.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="field">
          Group
          <input className="input" list="snippet-groups" placeholder="Docker, .NET, Node…" value={s.group} onChange={(e) => set('group', e.target.value)} />
          <datalist id="snippet-groups">
            {props.groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
        <label className="field span2">
          <span>Command <span className="hint">— {'{{name}}'} or {'{{name:default}}'} is asked when you run it; multiple lines run in order</span></span>
          <textarea
            className="input mono"
            rows={6}
            required
            spellCheck={false}
            placeholder="sudo systemctl restart myapi && journalctl -fu myapi"
            value={s.command}
            onChange={(e) => set('command', e.target.value)}
          />
        </label>
        <label className="field span2">
          <span>Description <span className="hint">— shown in the sidebar and command palette</span></span>
          <textarea
            className="input"
            rows={2}
            placeholder="What it does and when to use it"
            value={s.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </label>
      </form>
    </Modal>
  );
}
