import { useState } from 'react';
import { api, cleanError, clipboard, errorMessage } from '../api';
import type { GroupConfig, Host, Identity, KeyItem, Proxy, Tunnel } from '../types';
import { formatDate, hostLabel } from '../util';
import { EnvVarsEditor, HostSelect, IdentitySelect, KeySelect, ProxyEditor, SchemeSelect } from './fields';
import { Icon } from './Icon';
import { Modal } from './Modal';

function useSubmit(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(cleanError(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

function Footer({ onClose, form, busy, label = 'Save', extra }: { onClose(): void; form: string; busy: boolean; label?: string; extra?: React.ReactNode }) {
  return (
    <>
      {extra}
      <span className="spacer" />
      <button className="btn" onClick={onClose}>
        Cancel
      </button>
      <button className="btn primary" type="submit" form={form} disabled={busy}>
        {busy ? 'Working…' : label}
      </button>
    </>
  );
}

// ---------------- Group settings ----------------

export function GroupDialog(props: {
  group: GroupConfig;
  isNew: boolean;
  hosts: Host[];
  identities: Identity[];
  onSaved(): void;
  onDelete(path: string): void;
  onClose(): void;
}) {
  const [g, setG] = useState<GroupConfig>({ ...props.group, envVars: props.group.envVars ?? [] });
  const [path, setPath] = useState(props.group.path);
  const [proxyPassword, setProxyPassword] = useState('');
  const set = <K extends keyof GroupConfig>(k: K, v: GroupConfig[K]) => setG((p) => ({ ...p, [k]: v }));
  const count = props.hosts.filter((h) => h.group === props.group.path || h.group.startsWith(props.group.path + '/')).length;
  const { busy, error, run } = useSubmit(async () => {
    const target = path.trim().replace(/^\/+|\/+$/g, '');
    if (!props.isNew && target !== props.group.path) await api.renameGroup(props.group.path, target);
    await api.saveGroup({ ...g, path: target }, proxyPassword);
    props.onSaved();
  });
  return (
    <Modal
      title={props.isNew ? 'New group' : `Group settings — ${props.group.path}`}
      onClose={props.onClose}
      width={600}
      footer={
        <Footer
          onClose={props.onClose}
          form="group-form"
          busy={busy}
          extra={
            !props.isNew && (
              <button className="btn danger-text" onClick={() => props.onDelete(props.group.path)}>
                Delete group
              </button>
            )
          }
        />
      }
    >
      <form
        id="group-form"
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        {error && <div className="error-box span2">{error}</div>}
        <p className="hint span2">
          Hosts in this group{count ? ` (${count})` : ''} and its subgroups use these settings unless they set their own.
        </p>
        <label className="field span2">
          <span>
            Name <span className="hint">— use / to nest, e.g. Clients/Acme/Prod</span>
          </span>
          <input className="input" autoFocus required value={path} onChange={(e) => setPath(e.target.value)} placeholder="Production" />
        </label>
        <label className="field">
          Identity (credentials)
          <IdentitySelect value={g.identityId} onChange={(v) => set('identityId', v)} identities={props.identities} inheritLabel="None" />
        </label>
        <label className="field">
          Jump host for all hosts
          <HostSelect value={g.jumpHostId} onChange={(v) => set('jumpHostId', v)} hosts={props.hosts} emptyLabel="Direct connection" />
        </label>
        <label className="field">
          Color scheme
          <SchemeSelect value={g.scheme} onChange={(v) => set('scheme', v)} inheritLabel="App default" />
        </label>
        <label className="field">
          Agent forwarding
          <label className="check">
            <input type="checkbox" checked={g.agentForwarding} onChange={(e) => set('agentForwarding', e.target.checked)} />
            Forward my keys
          </label>
        </label>
        <label className="field span2">
          Startup command
          <input className="input mono" value={g.startupCommand} onChange={(e) => set('startupCommand', e.target.value)} placeholder="tmux attach || tmux" />
        </label>
        <div className="field span2">
          Proxy
          <ProxyEditor value={g.proxy} onChange={(p: Proxy | null) => set('proxy', p)} password={proxyPassword} onPassword={setProxyPassword} />
        </div>
        <div className="field span2">
          Environment variables
          <EnvVarsEditor value={g.envVars ?? []} onChange={(v) => set('envVars', v)} />
        </div>
      </form>
    </Modal>
  );
}

// ---------------- Identities ----------------

export function IdentityDialog(props: { identity: Identity | null; keys: KeyItem[]; onSaved(): void; onDelete(i: Identity): void; onClose(): void }) {
  const [i, setI] = useState<Identity>(props.identity ?? { id: '', label: '', username: '', keyId: '', hasPassword: false });
  const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit(async () => {
    await api.saveIdentity(i, password);
    props.onSaved();
  });
  return (
    <Modal
      title={props.identity ? `Identity — ${props.identity.label}` : 'New identity'}
      onClose={props.onClose}
      width={480}
      footer={
        <Footer
          onClose={props.onClose}
          form="identity-form"
          busy={busy}
          extra={
            props.identity && (
              <button className="btn danger-text" onClick={() => props.onDelete(props.identity!)}>
                Delete
              </button>
            )
          }
        />
      }
    >
      <form
        id="identity-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        {error && <div className="error-box">{error}</div>}
        <p className="hint">Use one identity for many hosts or groups — change the password once and every host follows.</p>
        <label className="field">
          Label
          <input className="input" value={i.label} onChange={(e) => setI({ ...i, label: e.target.value })} placeholder="deploy (prod)" />
        </label>
        <label className="field">
          Username
          <input className="input mono" required autoFocus value={i.username} onChange={(e) => setI({ ...i, username: e.target.value })} placeholder="deploy" />
        </label>
        <label className="field">
          Key
          <KeySelect value={i.keyId} onChange={(v) => setI({ ...i, keyId: v })} keys={props.keys} emptyLabel="No key" />
        </label>
        <label className="field">
          Password
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={i.hasPassword ? '•••••••• saved — leave empty to keep' : 'Optional'}
          />
        </label>
        {i.hasPassword && (
          <button
            type="button"
            className="btn sm"
            onClick={async () => {
              await api.clearIdentityPassword(i.id);
              setI({ ...i, hasPassword: false });
            }}
          >
            Forget saved password
          </button>
        )}
      </form>
    </Modal>
  );
}

// ---------------- Keys ----------------

export function GenerateKeyDialog(props: { onSaved(k: KeyItem): void; onClose(): void }) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState('ed25519');
  const [bits, setBits] = useState(0);
  const [passphrase, setPassphrase] = useState('');
  const [save, setSave] = useState(true);
  const { busy, error, run } = useSubmit(async () => {
    props.onSaved(await api.generateKey({ label, type, bits, passphrase, savePassphrase: save }));
  });
  return (
    <Modal title="Generate SSH key" onClose={props.onClose} width={480} footer={<Footer onClose={props.onClose} form="gen-form" busy={busy} label="Generate" />}>
      <form
        id="gen-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        {error && <div className="error-box">{error}</div>}
        <label className="field">
          Label
          <input className="input" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="work laptop" />
        </label>
        <label className="field">
          Type
          <select
            className="input"
            value={`${type}:${bits}`}
            onChange={(e) => {
              const [t, b] = e.target.value.split(':');
              setType(t);
              setBits(Number(b));
            }}
          >
            <option value="ed25519:0">Ed25519 — recommended, small and fast</option>
            <option value="ecdsa:256">ECDSA P-256</option>
            <option value="ecdsa:384">ECDSA P-384</option>
            <option value="rsa:4096">RSA 4096 — for old servers</option>
            <option value="rsa:3072">RSA 3072</option>
          </select>
        </label>
        <label className="field">
          Passphrase <span className="hint">— optional, encrypts the key file</span>
          <input className="input" type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </label>
        {passphrase && (
          <label className="check">
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
            Remember the passphrase in Windows Credential Manager
          </label>
        )}
      </form>
    </Modal>
  );
}

export function ImportKeyDialog(props: { onSaved(k: KeyItem): void; onClose(): void }) {
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [path, setPath] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [needPass, setNeedPass] = useState(false);
  const [save, setSave] = useState(true);
  const { busy, error, run, setError } = useSubmit(async () => {
    try {
      props.onSaved(await api.importKey({ label, privateKey: text, path, passphrase, savePassphrase: save }));
    } catch (e) {
      if (errorMessage(e).startsWith('PASSPHRASE_REQUIRED')) setNeedPass(true);
      throw e;
    }
  });
  return (
    <Modal title="Import private key" onClose={props.onClose} width={560} footer={<Footer onClose={props.onClose} form="imp-form" busy={busy} label="Import" />}>
      <form
        id="imp-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim() && !path) return setError('Paste a key or choose a file');
          void run();
        }}
      >
        {error && <div className="error-box">{error}</div>}
        <label className="field">
          Label
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="from my old laptop" />
        </label>
        <div className="field">
          Key file
          <div className="addr-row">
            <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/.ssh/id_ed25519" />
            <button
              type="button"
              className="btn"
              onClick={async () => {
                const p = await api.pickKeyFile().catch(() => '');
                if (p) setPath(p);
              }}
            >
              Browse…
            </button>
          </div>
        </div>
        <label className="field">
          …or paste the private key
          <textarea
            className="input mono"
            rows={6}
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
          />
        </label>
        {(needPass || passphrase) && (
          <>
            <label className="field">
              Passphrase
              <input className="input" type="password" autoFocus value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
              Remember the passphrase
            </label>
          </>
        )}
        <p className="hint">PuTTY .ppk keys: open them in PuTTYgen and use Conversions → Export OpenSSH key first.</p>
      </form>
    </Modal>
  );
}

export function KeyDetailsDialog(props: {
  keyItem: KeyItem;
  hosts: Host[];
  notify(text: string, kind?: 'info' | 'error'): void;
  onChanged(): void;
  onDelete(k: KeyItem): void;
  onClose(): void;
}) {
  const k = props.keyItem;
  const [label, setLabel] = useState(k.label);
  const [cert, setCert] = useState(k.certificate);
  const [hostId, setHostId] = useState('');
  const [password, setPassword] = useState('');
  const [needPassword, setNeedPassword] = useState(false);
  const [path, setPath] = useState('');
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);
  const { busy, error, run } = useSubmit(async () => {
    await api.updateKey(k.id, label, cert);
    props.onChanged();
    props.onClose();
  });

  const exportToHost = async () => {
    setExporting(true);
    setExportError('');
    try {
      await api.exportKeyToHost({ keyId: k.id, hostId, password, path });
      const h = props.hosts.find((x) => x.id === hostId);
      props.notify(`Key added to ${h?.name}'s authorized_keys and linked to the host`);
      props.onChanged();
      setHostId('');
      setNeedPassword(false);
    } catch (e) {
      const msg = errorMessage(e);
      if (msg.startsWith('AUTH_FAILED')) setNeedPassword(true);
      setExportError(cleanError(msg));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal
      title={`Key — ${k.label}`}
      onClose={props.onClose}
      width={600}
      footer={
        <Footer
          onClose={props.onClose}
          form="key-form"
          busy={busy}
          extra={
            <button className="btn danger-text" onClick={() => props.onDelete(k)}>
              Delete key
            </button>
          }
        />
      }
    >
      <form
        id="key-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        {error && <div className="error-box">{error}</div>}
        <div className="key-facts">
          <span>{k.type}</span>
          <span className="mono">{k.fingerprint}</span>
          <span>{k.encrypted ? (k.hasPassphrase ? 'passphrase saved' : 'passphrase asked on use') : 'no passphrase'}</span>
          <span>created {formatDate(k.created)}</span>
        </div>
        <label className="field">
          Label
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <div className="field">
          <span className="row-between">
            Public key
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                void clipboard.write(k.publicKey);
                props.notify('Public key copied');
              }}
            >
              <Icon name="insert" size={12} /> Copy
            </button>
          </span>
          <code className="cmd-view selectable">{k.publicKey}</code>
        </div>

        <div className="export-box">
          <b>Install on a server</b>
          <span className="hint">Adds the public key to ~/.ssh/authorized_keys (once) and links the key to the host.</span>
          <div className="addr-row">
            <HostSelect value={hostId} onChange={setHostId} hosts={props.hosts} emptyLabel="Choose a host…" />
            <button type="button" className="btn primary" disabled={!hostId || exporting} onClick={() => void exportToHost()}>
              {exporting ? 'Installing…' : 'Install key'}
            </button>
          </div>
          {needPassword && (
            <input
              className="input"
              type="password"
              autoFocus
              placeholder={`Password for ${hostLabel(props.hosts.find((h) => h.id === hostId) ?? { user: '', address: '', port: 22 })}`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
          <input className="input mono" placeholder="~/.ssh/authorized_keys" value={path} onChange={(e) => setPath(e.target.value)} />
          {exportError && <div className="error-box">{exportError}</div>}
        </div>

        <label className="field">
          <span>
            Certificate <span className="hint">— OpenSSH certificate signed for this key (…-cert-v01@openssh.com)</span>
          </span>
          <textarea className="input mono" rows={3} spellCheck={false} value={cert} onChange={(e) => setCert(e.target.value)} placeholder="ssh-ed25519-cert-v01@openssh.com AAAA…" />
        </label>
        {k.encrypted && (
          <button
            type="button"
            className="btn sm"
            onClick={async () => {
              await api.setKeyPassphrase(k.id, '');
              props.notify('Saved passphrase removed');
              props.onChanged();
            }}
            disabled={!k.hasPassphrase}
          >
            Forget saved passphrase
          </button>
        )}
      </form>
    </Modal>
  );
}

// ---------------- Port forwarding ----------------

const TUNNEL_HELP: Record<Tunnel['type'], string> = {
  local: 'Opens a port on this PC and forwards it through the SSH host — use it to reach a database, admin panel or API that only the server can see.',
  remote: 'Opens a port on the server that leads back to a service on this PC or network — e.g. show your local dev server to the remote side.',
  dynamic: 'Turns this PC into a SOCKS5 proxy that sends traffic through the SSH host. Point a browser at 127.0.0.1 and this port.',
};

export function TunnelDialog(props: { tunnel: Tunnel | null; hosts: Host[]; onSaved(t: Tunnel): void; onClose(): void }) {
  const [t, setT] = useState<Tunnel>(
    props.tunnel ?? { id: '', label: '', type: 'local', hostId: '', bindAddress: '', port: 0, destHost: '127.0.0.1', destPort: 0, autoStart: false },
  );
  const set = <K extends keyof Tunnel>(k: K, v: Tunnel[K]) => setT((p) => ({ ...p, [k]: v }));
  const { busy, error, run } = useSubmit(async () => props.onSaved(await api.saveTunnel(t)));
  const portLabel = t.type === 'remote' ? 'Port on the server' : t.type === 'dynamic' ? 'SOCKS port on this PC' : 'Port on this PC';
  return (
    <Modal title={props.tunnel ? 'Edit port forwarding' : 'New port forwarding'} onClose={props.onClose} width={560} footer={<Footer onClose={props.onClose} form="tun-form" busy={busy} />}>
      <form
        id="tun-form"
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        {error && <div className="error-box span2">{error}</div>}
        <div className="field span2">
          Type
          <div className="env-pick">
            {(['local', 'remote', 'dynamic'] as const).map((ty) => (
              <button type="button" key={ty} className={`env-chip ${t.type === ty ? 'on proto' : ''}`} onClick={() => set('type', ty)}>
                {ty === 'dynamic' ? 'Dynamic (SOCKS)' : ty[0].toUpperCase() + ty.slice(1)}
              </button>
            ))}
          </div>
          <span className="hint">{TUNNEL_HELP[t.type]}</span>
        </div>
        <label className="field span2">
          SSH host that carries the traffic
          <HostSelect value={t.hostId} onChange={(v) => set('hostId', v)} hosts={props.hosts} emptyLabel="Choose a host…" />
        </label>
        <label className="field">
          {portLabel}
          <input className="input mono" type="number" required min={1} max={65535} value={t.port || ''} onChange={(e) => set('port', Number(e.target.value))} placeholder="5433" />
        </label>
        <label className="field">
          <span>
            Bind address <span className="hint">— default 127.0.0.1</span>
          </span>
          <input className="input mono" value={t.bindAddress} onChange={(e) => set('bindAddress', e.target.value)} placeholder="127.0.0.1" />
        </label>
        {t.type !== 'dynamic' && (
          <label className="field span2">
            {t.type === 'local' ? 'Destination (as seen from the server)' : 'Destination (as seen from this PC)'}
            <div className="addr-row">
              <input className="input mono" required value={t.destHost} onChange={(e) => set('destHost', e.target.value)} placeholder="127.0.0.1" />
              <input className="input mono port" type="number" required min={1} max={65535} value={t.destPort || ''} onChange={(e) => set('destPort', Number(e.target.value))} placeholder="5432" />
            </div>
          </label>
        )}
        <label className="field">
          Label
          <input className="input" value={t.label} onChange={(e) => set('label', e.target.value)} placeholder="Postgres (prod)" />
        </label>
        <label className="field">
          Start automatically
          <label className="check">
            <input type="checkbox" checked={t.autoStart} onChange={(e) => set('autoStart', e.target.checked)} />
            With Termora, and reconnect if dropped
          </label>
        </label>
        {t.type === 'remote' && <p className="hint span2">Binding to anything other than 127.0.0.1 on the server needs GatewayPorts yes in its sshd_config.</p>}
      </form>
    </Modal>
  );
}

// ---------------- Pick hosts (multi-host snippet runs) ----------------

export function PickHostsDialog(props: { title: string; hosts: Host[]; confirmLabel: string; onPick(ids: string[]): void; onClose(): void }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const shown = props.hosts.filter((h) => `${h.name} ${h.group} ${h.address} ${(h.tags ?? []).join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      width={520}
      footer={
        <>
          <span className="hint">{sel.size} selected (max 16)</span>
          <span className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!sel.size || sel.size > 16} onClick={() => props.onPick([...sel])}>
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <div className="stack">
        <input className="input" autoFocus placeholder="Filter by name, group or tag" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="pick-list">
          {shown.map((h) => (
            <label key={h.id} className="check pick-row">
              <input type="checkbox" checked={sel.has(h.id)} onChange={() => toggle(h.id)} />
              <span className="pick-name">{h.name}</span>
              <span className="hint mono">{hostLabel(h)}</span>
              {h.group && <span className="hint">{h.group}</span>}
            </label>
          ))}
        </div>
        <button type="button" className="btn sm" onClick={() => setSel(new Set(shown.slice(0, 16).map((h) => h.id)))}>
          Select all shown
        </button>
      </div>
    </Modal>
  );
}
