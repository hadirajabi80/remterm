import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import type { GroupConfig, Host, Identity, KeyItem, Proxy } from '../types';
import { ENVS, PROTOCOLS, inherited } from '../util';
import { EnvVarsEditor, HostSelect, IdentitySelect, KeySelect, ProxyEditor, SchemeSelect, TagInput } from './fields';
import { Modal } from './Modal';

export const EMPTY_HOST: Host = {
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
  favorite: false,
  protocol: 'ssh',
  tags: [],
  keyId: '',
  identityId: '',
  agentForwarding: false,
  envVars: [],
  proxy: null,
  scheme: '',
  serial: null,
};

type Tab = 'general' | 'auth' | 'connection';

export function HostDialog(props: {
  host: Host | null;
  defaultGroup?: string;
  hosts: Host[];
  groups: GroupConfig[];
  identities: Identity[];
  keys: KeyItem[];
  onSave(h: Host, secret: string, proxyPassword: string, forgetSecret: boolean, connect: boolean): Promise<void>;
  onClose(): void;
}) {
  const [h, setH] = useState<Host>(() => {
    const base = { ...EMPTY_HOST, group: props.defaultGroup ?? '', ...props.host };
    return { ...base, protocol: base.protocol || 'ssh', tags: base.tags ?? [], envVars: base.envVars ?? [] };
  });
  const [tab, setTab] = useState<Tab>('general');
  const [secret, setSecret] = useState('');
  const [proxyPassword, setProxyPassword] = useState('');
  const [forget, setForget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connectAfter, setConnectAfter] = useState(false);
  const [ports, setPorts] = useState<string[]>([]);

  const set = <K extends keyof Host>(k: K, v: Host[K]) => setH((p) => ({ ...p, [k]: v }));
  const protocol = h.protocol || 'ssh';
  const isSSH = protocol === 'ssh';
  const allGroups = [...new Set([...props.hosts.map((x) => x.group), ...props.groups.map((g) => g.path)].filter(Boolean))].sort();
  const allTags = [...new Set(props.hosts.flatMap((x) => x.tags ?? []))].sort();
  const inheritedIdentity = inherited({ ...h, identityId: '' }, props.groups, 'identityId');
  const inheritedJump = inherited({ ...h, jumpHostId: '' }, props.groups, 'jumpHostId');
  const nameOf = (id: string) => props.hosts.find((x) => x.id === id)?.name ?? 'a deleted host';
  const identityName = (id: string) => props.identities.find((i) => i.id === id)?.label ?? 'deleted identity';

  useEffect(() => {
    if (protocol === 'serial') api.listSerialPorts().then(setPorts).catch(() => setPorts([]));
  }, [protocol]);

  // Pasting "user@host:port" into the address field fills all three.
  const splitAddress = () => {
    const m = h.address.trim().match(/^(?:ssh\s+)?(?:([^@\s]+)@)?([^:\s]+|\[[^\]]+\])(?::(\d+))?$/);
    if (!m) return;
    setH((p) => ({ ...p, user: m[1] ?? p.user, address: m[2].replace(/^\[|\]$/g, ''), port: m[3] ? Number(m[3]) : p.port }));
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await props.onSave({ ...h, port: Number(h.port) || (protocol === 'telnet' ? 23 : 22) }, secret, proxyPassword, forget, connectAfter);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const serial = h.serial ?? { port: '', baud: 9600, dataBits: 8, stopBits: '1', parity: 'none', flowControl: 'none' };
  const setSerial = (patch: Partial<typeof serial>) => set('serial', { ...serial, ...patch });

  return (
    <Modal
      title={props.host?.id ? `Edit ${props.host.name}` : 'New host'}
      onClose={props.onClose}
      width={620}
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
      <div className="dlg-tabs" role="tablist">
        {(
          [
            ['general', 'General'],
            ['auth', 'Credentials'],
            ['connection', isSSH ? 'Connection' : 'Terminal'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <form
        id="host-form"
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error && <div className="error-box span2">{error}</div>}

        {tab === 'general' && (
          <>
            <label className="field">
              Protocol
              <div className="env-pick">
                {PROTOCOLS.map((p) => (
                  <button
                    type="button"
                    key={p.value}
                    className={`env-chip ${protocol === p.value ? 'on proto' : ''}`}
                    onClick={() =>
                      setH((x) => ({
                        ...x,
                        protocol: p.value,
                        port: p.value === 'telnet' && x.port === 22 ? 23 : p.value === 'ssh' && x.port === 23 ? 22 : x.port,
                      }))
                    }
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </label>
            <label className="field">
              Display name
              <input className="input" placeholder={h.address || 'My server'} value={h.name} onChange={(e) => set('name', e.target.value)} />
            </label>

            {protocol === 'serial' ? (
              <>
                <label className="field">
                  Serial port
                  <select className="input" value={serial.port} onChange={(e) => setSerial({ port: e.target.value })}>
                    <option value="">{ports.length ? 'Choose…' : 'No serial ports found'}</option>
                    {ports.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Baud rate
                  <select className="input" value={serial.baud} onChange={(e) => setSerial({ baud: Number(e.target.value) })}>
                    {[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400].map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Data bits / parity / stop bits
                  <div className="addr-row">
                    <select className="input" value={serial.dataBits} onChange={(e) => setSerial({ dataBits: Number(e.target.value) })}>
                      {[8, 7, 6, 5].map((b) => (
                        <option key={b}>{b}</option>
                      ))}
                    </select>
                    <select className="input" value={serial.parity} onChange={(e) => setSerial({ parity: e.target.value })}>
                      {['none', 'odd', 'even', 'mark', 'space'].map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                    <select className="input" value={serial.stopBits} onChange={(e) => setSerial({ stopBits: e.target.value })}>
                      {['1', '1.5', '2'].map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </div>
                </label>
                <label className="field">
                  Flow control
                  <select className="input" value={serial.flowControl} onChange={(e) => setSerial({ flowControl: e.target.value })}>
                    <option value="none">None</option>
                    <option value="rts/cts">RTS/CTS</option>
                  </select>
                </label>
              </>
            ) : (
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
                  <input className="input mono port" type="number" min={1} max={65535} value={h.port} onChange={(e) => set('port', Number(e.target.value))} title="Port" />
                </div>
              </label>
            )}

            <label className="field">
              <span>
                Group <span className="hint">— nest with /, e.g. Clients/Acme</span>
              </span>
              <input className="input" list="host-groups" placeholder="Ungrouped" value={h.group} onChange={(e) => set('group', e.target.value)} />
              <datalist id="host-groups">
                {allGroups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
              <label className="check" style={{ marginTop: 6 }}>
                <input type="checkbox" checked={!!h.favorite} onChange={(e) => set('favorite', e.target.checked)} />
                ★ Favorite
              </label>
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
                    {env.value || 'none'}
                  </button>
                ))}
              </div>
            </label>
            <label className="field span2">
              Tags
              <TagInput value={h.tags ?? []} onChange={(v) => set('tags', v)} suggestions={allTags} />
            </label>
          </>
        )}

        {tab === 'auth' && (
          <>
            {isSSH && (
              <label className="field span2">
                <span>
                  Identity <span className="hint">— a saved username + password/key shared by many hosts</span>
                </span>
                <IdentitySelect
                  value={h.identityId}
                  onChange={(v) => set('identityId', v)}
                  identities={props.identities}
                  inheritLabel={inheritedIdentity ? `From group: ${identityName(inheritedIdentity)}` : 'None — use the fields below'}
                />
              </label>
            )}
            {!h.identityId && !inheritedIdentity && protocol !== 'serial' && (
              <label className="field">
                Username
                <input className="input mono" placeholder="root" value={h.user} onChange={(e) => set('user', e.target.value)} />
              </label>
            )}
            {isSSH && (
              <label className="field">
                Authentication
                <select className="input" value={h.authMethod} onChange={(e) => set('authMethod', e.target.value)}>
                  <option value="auto">Automatic (keys, agent, password)</option>
                  <option value="key">Keys only</option>
                  <option value="password">Password only</option>
                </select>
              </label>
            )}
            {isSSH && h.authMethod !== 'password' && (
              <>
                <label className="field">
                  Key from keychain
                  <KeySelect value={h.keyId} onChange={(v) => set('keyId', v)} keys={props.keys} emptyLabel={props.keys.length ? 'None' : 'Keychain is empty'} />
                </label>
                <label className="field">
                  <span>
                    …or key file <span className="hint">— empty = ~/.ssh defaults</span>
                  </span>
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
              </>
            )}
            {protocol !== 'serial' && (
              <label className="field span2">
                {isSSH ? 'Password / key passphrase' : 'Password (sent at the login prompt)'}
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
                    Forget saved password
                  </label>
                )}
              </label>
            )}
            {protocol === 'telnet' && <p className="hint span2">Telnet sends everything unencrypted — avoid it for anything sensitive.</p>}
            {protocol === 'serial' && <p className="hint span2">Serial connections need no credentials.</p>}
          </>
        )}

        {tab === 'connection' && (
          <>
            {isSSH && (
              <>
                <label className="field">
                  <span>
                    Jump host <span className="hint">— jump hosts can have their own</span>
                  </span>
                  <HostSelect
                    value={h.jumpHostId}
                    onChange={(v) => set('jumpHostId', v)}
                    hosts={props.hosts}
                    exclude={h.id}
                    emptyLabel={inheritedJump ? `From group: via ${nameOf(inheritedJump)}` : 'Direct connection'}
                  />
                </label>
                <label className="field">
                  Agent forwarding
                  <label className="check">
                    <input type="checkbox" checked={h.agentForwarding} onChange={(e) => set('agentForwarding', e.target.checked)} />
                    Forward my keys (git pull, onward ssh)
                  </label>
                </label>
                <div className="field span2">
                  <span>
                    Proxy <span className="hint">— SOCKS5 or HTTP, for the first hop</span>
                  </span>
                  <ProxyEditor value={h.proxy} onChange={(p: Proxy | null) => set('proxy', p)} password={proxyPassword} onPassword={setProxyPassword} />
                </div>
                <div className="field span2">
                  <span>
                    Environment variables <span className="hint">— the server must allow them (AcceptEnv)</span>
                  </span>
                  <EnvVarsEditor value={h.envVars ?? []} onChange={(v) => set('envVars', v)} />
                </div>
                <label className="field span2">
                  <span>
                    Startup command <span className="hint">— runs right after login</span>
                  </span>
                  <input
                    className="input mono"
                    placeholder="cd /var/www/app && git status"
                    value={h.startupCommand}
                    onChange={(e) => set('startupCommand', e.target.value)}
                  />
                </label>
              </>
            )}
            <label className="field">
              Color scheme
              <SchemeSelect
                value={h.scheme}
                onChange={(v) => set('scheme', v)}
                inheritLabel={inherited({ ...h, scheme: '' }, props.groups, 'scheme') ? 'From group' : 'App default'}
              />
            </label>
          </>
        )}
      </form>
    </Modal>
  );
}
