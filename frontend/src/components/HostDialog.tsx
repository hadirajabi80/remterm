import { useState } from 'react';
import { api, errorMessage } from '../api';
import type { Host } from '../types';
import { ENVS } from '../util';
import { Modal } from './Modal';

const EMPTY: Host = {
  id: '',
  name: '',
  group: '',
  env: '',
  address: '',
  port: 22,
  user: '',
  authMethod: 'auto',
  keyPath: '',
  jumpHostId: '',
  startupCommand: '',
  hasSecret: false,
  lastUsed: 0,
};

export function HostDialog(props: {
  host: Host | null;
  hosts: Host[];
  onSave(h: Host, secret: string, forgetSecret: boolean, connect: boolean): Promise<void>;
  onClose(): void;
}) {
  const [h, setH] = useState<Host>(props.host ?? EMPTY);
  const [secret, setSecret] = useState('');
  const [forget, setForget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connectAfter, setConnectAfter] = useState(false);

  const set = <K extends keyof Host>(k: K, v: Host[K]) => setH((p) => ({ ...p, [k]: v }));
  const groups = [...new Set(props.hosts.map((x) => x.group).filter(Boolean))].sort();
  const jumpCandidates = props.hosts.filter((x) => x.id !== h.id);

  // Pasting "user@host:port" into the address field fills all three.
  const splitAddress = () => {
    const m = h.address.trim().match(/^(?:ssh\s+)?(?:([^@\s]+)@)?([^:\s]+|\[[^\]]+\])(?::(\d+))?$/);
    if (!m) return;
    setH((p) => ({
      ...p,
      user: m[1] ?? p.user,
      address: m[2].replace(/^\[|\]$/g, ''),
      port: m[3] ? Number(m[3]) : p.port,
    }));
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await props.onSave({ ...h, port: Number(h.port) || 22 }, secret, forget, connectAfter);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const secretLabel = h.authMethod === 'key' ? 'Key passphrase' : h.authMethod === 'password' ? 'Password' : 'Password / key passphrase';

  return (
    <Modal
      title={props.host ? `Edit ${props.host.name}` : 'New host'}
      onClose={props.onClose}
      width={580}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" form="host-form" disabled={busy} onClick={() => setConnectAfter(false)}>
            Save
          </button>
          <button className="btn primary" type="submit" form="host-form" disabled={busy} onClick={() => setConnectAfter(true)}>
            Save & connect
          </button>
        </>
      }
    >
      <form
        id="host-form"
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error && <div className="error-box span2">{error}</div>}

        <label className="field span2">
          Address
          <div className="addr-row">
            <input
              className="input mono"
              autoFocus
              required
              placeholder="server.example.com, 10.0.0.5 or user@host:port"
              value={h.address}
              onChange={(e) => set('address', e.target.value)}
              onBlur={splitAddress}
            />
            <input
              className="input mono port"
              type="number"
              min={1}
              max={65535}
              value={h.port}
              onChange={(e) => set('port', Number(e.target.value))}
              title="Port"
            />
          </div>
        </label>

        <label className="field">
          Username
          <input className="input mono" placeholder="root" value={h.user} onChange={(e) => set('user', e.target.value)} />
        </label>
        <label className="field">
          Display name
          <input className="input" placeholder={h.address || 'My server'} value={h.name} onChange={(e) => set('name', e.target.value)} />
        </label>

        <label className="field">
          Group
          <input className="input" list="host-groups" placeholder="e.g. Clients, Personal" value={h.group} onChange={(e) => set('group', e.target.value)} />
          <datalist id="host-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
        <label className="field">
          Environment
          <div className="env-pick">
            {ENVS.map((env) => (
              <button
                type="button"
                key={env.value}
                className={`env-chip env-${env.value || 'none'} ${h.env === env.value ? 'on' : ''}`}
                onClick={() => set('env', env.value)}
              >
                {env.value ? env.value : 'none'}
              </button>
            ))}
          </div>
        </label>

        <div className="divider span2" />

        <label className="field">
          Authentication
          <select className="input" value={h.authMethod} onChange={(e) => set('authMethod', e.target.value)}>
            <option value="auto">Automatic (keys, agent, password)</option>
            <option value="key">Private key only</option>
            <option value="password">Password only</option>
          </select>
        </label>
        <label className="field">
          Jump host
          <select className="input" value={h.jumpHostId} onChange={(e) => set('jumpHostId', e.target.value)}>
            <option value="">Direct connection</option>
            {jumpCandidates.map((x) => (
              <option key={x.id} value={x.id}>
                via {x.name}
              </option>
            ))}
          </select>
        </label>

        {h.authMethod !== 'password' && (
          <label className="field span2">
            <span>Private key file <span className="hint">— empty = ~/.ssh/id_ed25519, id_ecdsa, id_rsa</span></span>
            <div className="addr-row">
              <input className="input mono" placeholder="~/.ssh/id_ed25519" value={h.keyPath} onChange={(e) => set('keyPath', e.target.value)} />
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  const p = await api.pickKeyFile().catch(() => '');
                  if (p) set('keyPath', p);
                }}
              >
                Browse…
              </button>
            </div>
          </label>
        )}

        <label className="field span2">
          {secretLabel}
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder={h.hasSecret && !forget ? '•••••••• saved — leave empty to keep' : 'Optional — you will be asked when needed'}
            value={secret}
            disabled={forget}
            onChange={(e) => setSecret(e.target.value)}
          />
          {h.hasSecret && (
            <label className="check">
              <input type="checkbox" checked={forget} onChange={(e) => setForget(e.target.checked)} />
              Forget saved secret
            </label>
          )}
        </label>

        <label className="field span2">
          <span>Startup command <span className="hint">— runs right after login</span></span>
          <input
            className="input mono"
            placeholder="cd /var/www/app && git status"
            value={h.startupCommand}
            onChange={(e) => set('startupCommand', e.target.value)}
          />
        </label>
      </form>
    </Modal>
  );
}
