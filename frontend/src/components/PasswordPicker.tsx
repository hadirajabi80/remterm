import { useState } from 'react';
import { errorMessage } from '../api';
import type { PasswordItem } from '../types';
import { Modal } from './Modal';
import { Icon } from './Icon';

export function PasswordPicker(props: {
  items: PasswordItem[];
  target: string;
  onFill(item: PasswordItem): Promise<void>;
  onManage(item: PasswordItem | null, onSaved?: (item: PasswordItem) => void): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const items = props.items.filter((p) => p.title.toLowerCase().includes(query.toLowerCase()));
  const fill = async (item: PasswordItem) => {
    setBusy(true);
    setError('');
    try { await props.onFill(item); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title="Fill password" onClose={props.onClose} width={500} footer={
      <>
        <button className="btn" disabled={busy} onClick={() => props.onManage(null, (p) => { void fill(p); })}>+ Save new password</button>
        <span className="spacer" />
        <button className="btn" onClick={props.onClose}>Close</button>
      </>
    }>
      <div className="stack">
        <div className="auth-target"><Icon name="terminal" /><span>{props.target}</span></div>
        <p className="hint">Choose a password to fill in this terminal. Press Enter yourself when ready.</p>
        {error && <div className="error-box">{error}</div>}
        {props.items.length > 0 && <input className="input" autoFocus placeholder="Find a saved password by title…" value={query} onChange={(e) => setQuery(e.target.value)} />}
        {items.length === 0 && <div className="side-empty">{props.items.length ? 'No password matches this title.' : 'Save your first password below. You can reuse it on any server.'}</div>}
        <div className="password-picker-list">
          {items.map((p) => (
            <div className="row" key={p.id}>
              <span className="host-ico env-none"><Icon name="key" size={14} /></span>
              <div className="row-main"><div className="row-title">{p.title}</div><div className="row-sub">••••••••</div></div>
              <button className="btn sm" disabled={busy} onClick={() => props.onManage(p)}>Edit</button>
              <button className="btn primary sm" disabled={busy} onClick={() => { void fill(p); }}>Fill password</button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
