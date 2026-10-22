import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../api';
import { bastionLogin, makeTarget, rdp, useCover } from '../rdp';
import { NO_CREDENTIAL, type Bastion, type Machine, type RdpCredential, type RdpData, type RdpQuality, type RdpSettings } from '../types';
import { Icon } from './Icon';
import { Modal } from './Modal';

/** Picture quality levels, best first (the engine's RdpQuality). */
export const RDP_QUALITIES: { value: RdpQuality; label: string; hint: string }[] = [
  { value: 'best', label: 'Best', hint: 'Full colours and every desktop effect' },
  { value: 'balanced', label: 'Balanced', hint: 'No wallpaper, animations or window contents while dragging' },
  { value: 'fast', label: 'Fast', hint: '16-bit colours, plain look, RDP low-bandwidth mode' },
  { value: 'fastest', label: 'Fastest', hint: 'As Fast, with a 25% smaller remote screen scaled to fit (softer text)' },
];

export const EMPTY_MACHINE: Machine = {
  id: '',
  name: '',
  ip: '',
  target: '',
  group: '',
  mode: 'direct',
  credentialId: null,
  username: '',
  autoType: 'auto',
  favorite: false,
  lastUsed: null,
  notes: '',
};

const credLabel = (c: RdpCredential) => (c.username && c.username !== c.name ? `${c.name} (${c.username})` : c.name);

/** Login select: '' = default login, 'none' = never fill, else a login id. */
function LoginSelect(props: { value: string; onChange(v: string): void; data: RdpData; allowNone?: boolean }) {
  const def = props.data.credentials.find((c) => c.id === props.data.defaultCredentialId);
  return (
    <select className="input" value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      <option value="">★ Default login{def ? ` — ${credLabel(def)}` : ''}</option>
      {props.data.credentials.map((c) => (
        <option key={c.id} value={c.id}>
          {credLabel(c)}
        </option>
      ))}
      {props.allowNone !== false && <option value={NO_CREDENTIAL}>Ask me when connecting</option>}
    </select>
  );
}

function PasswordInput(props: { value: string; onChange(v: string): void; saved: boolean; placeholder?: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw-row">
      <input
        className="input"
        type={show ? 'text' : 'password'}
        autoFocus={props.autoFocus}
        value={props.value}
        placeholder={props.saved ? '•••••• saved — leave empty to keep' : (props.placeholder ?? 'Password')}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <button type="button" className="icon-btn sm" title={show ? 'Hide' : 'Show'} onClick={() => setShow((v) => !v)}>
        <Icon name={show ? 'eyeOff' : 'eye'} size={14} />
      </button>
    </div>
  );
}

// =============================================================================================== machine

/** Where a machine's login comes from: typed right here, a saved login, or asked on every connect. */
type LoginSource = 'own' | 'saved' | 'ask';

const loginSourceOf = (m: Machine | null): LoginSource => {
  if (!m?.id || m.username) return 'own';
  return m.credentialId === NO_CREDENTIAL ? 'ask' : 'saved';
};

export function MachineDialog(props: {
  machine: Machine | null;
  defaultGroup?: string;
  data: RdpData;
  /** Folder names to suggest besides the Remote Desktop groups (SSH host groups). */
  folders?: string[];
  onSaved(m: Machine, connect: boolean): void;
  onClose(): void;
}) {
  const [m, setM] = useState<Machine>(() => ({ ...EMPTY_MACHINE, group: props.defaultGroup ?? '', ...props.machine }));
  const [targetEdited, setTargetEdited] = useState(() => !!props.machine?.target && props.machine.target !== makeTarget(props.machine.name, props.machine.ip));
  const [source, setSource] = useState<LoginSource>(() => loginSourceOf(props.machine));
  const [password, setPassword] = useState('');
  const [alsoSave, setAlsoSave] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connectAfter, setConnectAfter] = useState(false);
  const groups = useMemo(
    () => [...new Set([...props.data.machines.map((x) => x.group), ...(props.folders ?? [])].filter(Boolean))].sort(),
    [props.data.machines, props.folders],
  );
  const set = <K extends keyof Machine>(k: K, v: Machine[K]) => setM((p) => ({ ...p, [k]: v }));
  const bastion = m.mode === 'bastion';
  // The password field says "saved" only while the machine still has the login it was saved with.
  const savedPassword = !!props.machine?.hasPassword && !!props.machine.username;

  // The WALLIX target follows name + IP until it is edited by hand.
  const setNameOrIp = (patch: Partial<Machine>) =>
    setM((p) => {
      const n = { ...p, ...patch };
      if (!targetEdited && n.name.trim()) n.target = makeTarget(n.name, n.ip);
      return n;
    });

  const submit = async () => {
    setError('');
    const out: Machine = { ...m, name: m.name.trim() || m.ip.trim() };
    let pw: string | null = null;
    if (source === 'own') {
      out.username = (m.username ?? '').trim();
      if (!out.username) {
        setError(bastion ? 'Enter the machine login, or pick “Saved login” or “Type it myself”.' : 'Enter the user name, or pick “Ask each time”.');
        return;
      }
      out.credentialId = null;
      // Empty keeps the saved password; a machine that had no own login gets exactly what was typed.
      pw = password || !savedPassword ? password : null;
    } else {
      out.username = '';
      if (source === 'ask') out.credentialId = NO_CREDENTIAL;
      else if (out.credentialId === NO_CREDENTIAL) out.credentialId = null;
    }
    setBusy(true);
    try {
      if (source === 'own' && alsoSave) await rdp.saveCredential({ id: '', name: out.username!, username: out.username! }, password);
      const saved = await rdp.saveMachine(out, pw);
      props.onSaved(saved, connectAfter);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const chip = (on: boolean, label: string, onClick: () => void) => (
    <button type="button" className={`env-chip ${on ? 'on proto' : ''}`} onClick={onClick}>
      {label}
    </button>
  );

  return (
    <Modal
      title={props.machine?.id ? `Edit ${props.machine.name}` : 'New Remote Desktop connection'}
      onClose={props.onClose}
      width={580}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" form="machine-form" disabled={busy} onClick={() => setConnectAfter(false)}>
            Save
          </button>
          <button className="btn primary" type="submit" form="machine-form" disabled={busy} onClick={() => setConnectAfter(true)}>
            Save & connect
          </button>
        </>
      }
    >
      <form
        id="machine-form"
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error && <div className="error-box span2">{error}</div>}
        <label className="field">
          Name
          <input className="input" autoFocus placeholder="DC-01" value={m.name} onChange={(e) => setNameOrIp({ name: e.target.value })} />
        </label>
        <label className="field">
          Host or IP
          <input
            className="input mono"
            placeholder={bastion ? '172.16.170.221' : '10.0.0.5 or 10.0.0.5:3390'}
            value={m.ip}
            onChange={(e) => setNameOrIp({ ip: e.target.value })}
          />
        </label>
        <div className="field span2">
          Connect
          <div className="env-pick">
            {chip(!bastion, 'Direct', () => set('mode', 'direct'))}
            {chip(bastion, 'Through the WALLIX bastion', () => {
              set('mode', 'bastion');
              // WALLIX machines usually share one target login: start new ones on the saved logins.
              if (!props.machine?.id && !m.username?.trim() && props.data.credentials.length) setSource('saved');
            })}
          </div>
        </div>
        {bastion && (
          <label className="field span2">
            WALLIX target <span className="hint">— as in the WALLIX list; empty opens the list</span>
            <input
              className="input mono"
              placeholder="Interactive@NFCore-172.16.170.221:RDP"
              value={m.target}
              onChange={(e) => {
                setTargetEdited(true);
                set('target', e.target.value);
              }}
            />
          </label>
        )}

        <div className="field span2">
          {bastion ? (
            <span>
              Machine login <span className="hint">— typed on WALLIX's “Target Information Required” screen</span>
            </span>
          ) : (
            'Login'
          )}
          <div className="env-pick">
            {chip(source === 'own', 'User and password', () => setSource('own'))}
            {chip(source === 'saved', 'Saved login', () => setSource('saved'))}
            {chip(source === 'ask', bastion ? 'Type it myself' : 'Ask each time', () => setSource('ask'))}
          </div>
        </div>
        {source === 'own' && (
          <>
            <label className="field">
              User name
              <input className="input mono" placeholder="CORP\admin" value={m.username ?? ''} onChange={(e) => set('username', e.target.value)} />
            </label>
            <label className="field">
              Password
              <PasswordInput value={password} onChange={setPassword} saved={savedPassword} />
            </label>
            <label className="check span2">
              <input type="checkbox" checked={alsoSave} onChange={(e) => setAlsoSave(e.target.checked)} />
              Also save as a reusable login <span className="hint">— to pick it for other machines</span>
            </label>
          </>
        )}
        {source === 'saved' &&
          (props.data.credentials.length ? (
            <label className="field span2">
              <LoginSelect
                value={m.credentialId && m.credentialId !== NO_CREDENTIAL ? m.credentialId : ''}
                onChange={(v) => set('credentialId', v || null)}
                data={props.data}
                allowNone={false}
              />
            </label>
          ) : (
            <p className="hint span2 form-note">
              No saved logins yet. Use “User and password” and tick “Also save as a reusable login” to share one with other machines.
            </p>
          ))}
        {source === 'ask' && (
          <p className="hint span2 form-note">
            {bastion
              ? 'Nothing is typed on the target screen. Press Ctrl+Alt+K in the session to pick a login.'
              : 'Remterm asks for the user name and password every time you connect. Nothing is saved.'}
          </p>
        )}

        <label className="field">
          Folder
          <input className="input" list="rdp-groups" placeholder="No folder" value={m.group} onChange={(e) => set('group', e.target.value)} />
          <datalist id="rdp-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
        <label className="check" style={{ alignSelf: 'end', paddingBottom: 8 }}>
          <input type="checkbox" checked={m.favorite} onChange={(e) => set('favorite', e.target.checked)} />
          ★ Favorite
        </label>

        <button type="button" className={`more-toggle span2 ${more ? 'open' : ''}`} onClick={() => setMore((v) => !v)}>
          <Icon name="chevron" size={11} />
          {more ? 'Fewer options' : 'More options'}
          {!more && <span className="hint"> — auto-fill, picture quality, keep connected, notes</span>}
        </button>
        {more && (
          <>
            <label className="field">
              Auto-fill
              <select className="input" value={m.autoType} onChange={(e) => set('autoType', e.target.value as Machine['autoType'])}>
                <option value="auto">Automatic</option>
                <option value="always">Always</option>
                <option value="never">Never</option>
              </select>
            </label>
            {!props.data.external ? (
              <label className="field">
                Picture quality
                <select className="input" value={m.quality ?? ''} onChange={(e) => set('quality', e.target.value as Machine['quality'])}>
                  <option value="">
                    Default ({RDP_QUALITIES.find((q) => q.value === (props.data.settings.quality ?? 'best'))?.label ?? 'Best'})
                  </option>
                  {RDP_QUALITIES.map((q) => (
                    <option key={q.value} value={q.value} title={q.hint}>
                      {q.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div />
            )}
            <label className="check span2 keep-check">
              <input type="checkbox" checked={!!m.keepAlive} onChange={(e) => set('keepAlive', e.target.checked)} />
              <span>
                Keep connected
                <span className="hint"> — reconnect by itself when the connection drops, and stop the server signing you out when idle</span>
              </span>
            </label>
            <label className="field span2">
              Notes
              <textarea className="input" rows={2} value={m.notes} onChange={(e) => set('notes', e.target.value)} />
            </label>
          </>
        )}
      </form>
    </Modal>
  );
}

/** Asked when connecting to a machine (or a typed address) that has no login to use. */
export function RdpLoginPrompt(props: {
  host: string;
  machine?: Machine;
  onConnect(r: { username: string; password: string; remember: boolean }): void;
  onClose(): void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  return (
    <Modal
      title={`Connect to ${props.machine?.name ?? props.host}`}
      onClose={props.onClose}
      width={420}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" type="submit" form="rdp-login-form">
            Connect
          </button>
        </>
      }
    >
      <form
        id="rdp-login-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!username.trim()) {
            setError('Enter a user name.');
            return;
          }
          props.onConnect({ username: username.trim(), password, remember });
        }}
      >
        <p className="muted-text">
          Remote Desktop to <code>{props.host}</code>
        </p>
        {error && <div className="error-box">{error}</div>}
        <label className="field">
          User name
          <input
            className="input mono"
            autoFocus
            placeholder="CORP\admin"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setError('');
            }}
          />
        </label>
        <label className="field">
          Password
          <PasswordInput value={password} onChange={setPassword} saved={false} />
        </label>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {props.machine ? 'Remember for this machine' : 'Save as a Remote Desktop connection'}
        </label>
      </form>
    </Modal>
  );
}

// =============================================================================================== logins

export function LoginsDialog(props: { data: RdpData; onChanged(): void; onClose(): void }) {
  const list = props.data.credentials;
  const [selId, setSelId] = useState<string | null>(() => props.data.defaultCredentialId ?? list[0]?.id ?? null);
  const current = list.find((c) => c.id === selId);
  const [draft, setDraft] = useState({ id: '', name: '', username: '' });
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isNew = !current;

  useEffect(() => {
    setDraft(current ? { id: current.id, name: current.name, username: current.username } : { id: '', name: '', username: '' });
    setPassword('');
    setError('');
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const saved = await rdp.saveCredential(draft, isNew || password ? password : null);
      setSelId(saved.id);
      setPassword('');
      props.onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [selId]);
  const users = current ? props.data.machines.filter((m) => m.credentialId === current.id).length : 0;
  const remove = async () => {
    if (!current) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await rdp.deleteCredential(current.id).catch((e) => setError(errorMessage(e)));
    setSelId(null);
    props.onChanged();
  };

  return (
    <Modal
      title="Saved logins"
      onClose={props.onClose}
      width={680}
      footer={
        <button className="btn primary" onClick={props.onClose}>
          Done
        </button>
      }
    >
      <p className="muted-text" style={{ marginBottom: 12 }}>
        Logins you share between several machines. A machine that needs its own user name and password doesn't need one here: type them in
        the machine's dialog. In a session press <kbd>Ctrl+Alt+K</kbd> to pick one. Stored encrypted (AES-256, bound to your Windows account).
      </p>
      <div className="logins">
        <div className="logins-list">
          {list.map((c) => (
            <button key={c.id} className={`login-item ${c.id === selId ? 'on' : ''}`} onClick={() => setSelId(c.id)}>
              <span className={`login-star ${c.id === props.data.defaultCredentialId ? 'on' : ''}`} title="Default login">
                ★
              </span>
              <span className="login-main">
                <span className="login-name">{c.name}</span>
                <span className="login-user">{c.username || '—'}</span>
              </span>
            </button>
          ))}
          <button className={`login-item add ${isNew ? 'on' : ''}`} onClick={() => setSelId(null)}>
            <Icon name="plus" size={13} /> New login
          </button>
        </div>
        <form
          className="stack logins-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {error && <div className="error-box">{error}</div>}
          <label className="field">
            Name
            <input className="input" placeholder="Default" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="field">
            Login <span className="hint">— exactly as typed, e.g. DOMAIN\user</span>
            <input className="input mono" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
          </label>
          <label className="field">
            Password
            <PasswordInput value={password} onChange={setPassword} saved={!!current?.hasPassword} />
          </label>
          <div className="row-btns">
            <button className="btn primary" type="submit" disabled={busy}>
              {isNew ? 'Add login' : 'Save'}
            </button>
            {current && current.id !== props.data.defaultCredentialId && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void rdp
                    .setDefaultCredential(current.id)
                    .then(props.onChanged)
                    .catch((e) => setError(errorMessage(e)))
                }
              >
                ★ Make default
              </button>
            )}
            {current && (
              <button type="button" className={`btn ${confirmDelete ? 'danger-solid' : 'danger-text'}`} onClick={() => void remove()}>
                {confirmDelete ? 'Click again to delete' : 'Delete'}
              </button>
            )}
          </div>
          {confirmDelete && users > 0 && (
            <p className="hint">
              {users} machine{users === 1 ? ' uses' : 's use'} this login; they will use the default login instead.
            </p>
          )}
        </form>
      </div>
    </Modal>
  );
}

// =============================================================================================== settings

export type RdpSettingsTab = 'bastion' | 'fill' | 'display' | 'devices' | 'security';

const SETTINGS_PAGES: { id: RdpSettingsTab; icon: string; title: string; sub: string }[] = [
  { id: 'bastion', icon: 'shield', title: 'WALLIX bastion', sub: 'Server and your login' },
  { id: 'fill', icon: 'key', title: 'Logins & auto-fill', sub: 'What is typed for you' },
  { id: 'display', icon: 'monitor', title: 'Display', sub: 'Resolution and quality' },
  { id: 'devices', icon: 'keyboard', title: 'Devices & keyboard', sub: 'Clipboard, drives, keys' },
  { id: 'security', icon: 'lock', title: 'Security', sub: 'Master password, lock' },
];

/** One setting: what it is on the left, its control on the right. */
function SettingRow(props: { title: string; hint?: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`rs-row ${props.wide ? 'wide' : ''}`}>
      <div className="rs-row-text">
        <div className="rs-row-title">{props.title}</div>
        {props.hint && <div className="rs-row-hint">{props.hint}</div>}
      </div>
      <div className="rs-row-ctl">{props.children}</div>
    </div>
  );
}

function SettingGroup(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="rs-group">
      <div className="rs-group-title">{props.title}</div>
      <div className="rs-group-body">{props.children}</div>
    </section>
  );
}

function Switch(props: { checked: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <label className="switch" title={props.label}>
      <input type="checkbox" aria-label={props.label} checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <i />
    </label>
  );
}

export function RdpSettingsDialog(props: { data: RdpData; tab?: RdpSettingsTab; onLogins(): void; onChanged(): void; onClose(): void }) {
  const pages = SETTINGS_PAGES.filter((p) => !(props.data.external && p.id === 'security'));
  const [tab, setTab] = useState<RdpSettingsTab>(props.tab ?? 'bastion');
  const [b, setB] = useState<Bastion>({ ...props.data.bastion });
  const [s, setS] = useState<RdpSettings>({ ...props.data.settings });
  const [primaryPassword, setPrimaryPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const setb = <K extends keyof Bastion>(k: K, v: Bastion[K]) => setB((p) => ({ ...p, [k]: v }));
  const sets = <K extends keyof RdpSettings>(k: K, v: RdpSettings[K]) => setS((p) => ({ ...p, [k]: v }));
  const example = bastionLogin(b.loginTemplate, 'Interactive@NFCore-172.16.170.221:RDP', b.authorization, b.primaryUser || 'user');
  const page = pages.find((p) => p.id === tab) ?? pages[0];
  const external = !!props.data.external;

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await rdp.saveBastion(b, primaryPassword ? primaryPassword : null);
      await rdp.saveSettings(s);
      props.onChanged();
      props.onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  /** A yes/no setting from RdpSettings. */
  const toggle = (k: keyof RdpSettings, title: string, hint?: string) => (
    <SettingRow title={title} hint={hint}>
      <Switch label={title} checked={!!s[k]} onChange={(v) => sets(k, v as never)} />
    </SettingRow>
  );

  return (
    <Modal
      title="Remote Desktop settings"
      onClose={props.onClose}
      width={820}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" type="submit" form="rdp-settings-form" disabled={busy}>
            Save
          </button>
        </>
      }
    >
      <form
        id="rdp-settings-form"
        className="rs"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <nav className="rs-nav" role="tablist" aria-label="Settings sections">
          {pages.map((p) => (
            <button key={p.id} type="button" role="tab" aria-selected={p.id === page.id} className={p.id === page.id ? 'on' : ''} onClick={() => setTab(p.id)}>
              <Icon name={p.icon} size={15} />
              <span>
                <span className="rs-nav-title">{p.title}</span>
                <span className="rs-nav-sub">{p.sub}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="rs-pane" role="tabpanel">
          {error && <div className="error-box">{error}</div>}

          {page.id === 'bastion' && (
            <>
              <p className="rs-lead">Machines set to “Through the WALLIX bastion” connect here first. Direct machines ignore this page.</p>
              <SettingGroup title="Bastion server">
                <SettingRow title="Address" hint="The bastion you would open with mstsc">
                  <div className="rs-inline">
                    <input className="input mono" placeholder="10.10.10.10" value={b.host} onChange={(e) => setb('host', e.target.value)} />
                    <input
                      className="input mono rs-port"
                      type="number"
                      min={1}
                      max={65535}
                      title="Port"
                      value={b.port}
                      onChange={(e) => setb('port', Number(e.target.value))}
                    />
                  </div>
                </SettingRow>
                <SettingRow title="Server certificate">
                  <select className="input" value={b.authLevel} onChange={(e) => setb('authLevel', Number(e.target.value))}>
                    <option value={0}>Pin the key on first use (recommended)</option>
                    <option value={1}>Require a valid certificate</option>
                    <option value={2}>Warn me (Windows dialog)</option>
                  </select>
                </SettingRow>
                <SettingRow title="Use NLA (CredSSP)" hint="For the bastion login">
                  <Switch label="Use NLA" checked={b.useNla} onChange={(v) => setb('useNla', v)} />
                </SettingRow>
              </SettingGroup>
              <SettingGroup title="Your bastion login">
                <SettingRow title="User name">
                  <input className="input" value={b.primaryUser} onChange={(e) => setb('primaryUser', e.target.value)} />
                </SettingRow>
                <SettingRow title="Password" hint="Optional. Asked when connecting if empty">
                  <PasswordInput value={primaryPassword} onChange={setPrimaryPassword} saved={b.hasPassword} />
                </SettingRow>
                <SettingRow title="Authorization" hint="From the WALLIX list (optional)">
                  <input className="input" value={b.authorization} onChange={(e) => setb('authorization', e.target.value)} />
                </SettingRow>
              </SettingGroup>
              <SettingGroup title="WALLIX login">
                <SettingRow title="Login format" hint={<code className="rs-example">{example}</code>}>
                  <input className="input mono" value={b.loginTemplate} placeholder="{target}:{auth}:{user}" onChange={(e) => setb('loginTemplate', e.target.value)} />
                </SettingRow>
                <SettingRow
                  title="Type the full target on WALLIX's login page"
                  hint="Off: types your user name and you pick from the list. On: goes straight to the machine."
                >
                  <Switch label="Type the full target" checked={b.interactiveLoginUsesTarget} onChange={(v) => setb('interactiveLoginUsesTarget', v)} />
                </SettingRow>
              </SettingGroup>
            </>
          )}

          {page.id === 'fill' && (
            <>
              <p className="rs-lead">
                A machine can have its own user name and password (in its dialog), or use a saved login shared by several machines. In a session,{' '}
                <kbd>Ctrl+Alt+K</kbd> picks one and types it.
              </p>
              <SettingGroup title="Saved logins">
                <SettingRow
                  title={`${props.data.credentials.length} saved login${props.data.credentials.length === 1 ? '' : 's'}`}
                  hint="Shared between machines; one is the default"
                >
                  <button type="button" className="btn sm" onClick={props.onLogins}>
                    <Icon name="key" size={12} /> Manage logins…
                  </button>
                </SettingRow>
              </SettingGroup>
              {external ? (
                <p className="rs-lead">
                  On this computer sessions open in Microsoft's Windows App: the server and the WALLIX login are filled in and the password is put on the
                  clipboard for ⌘V. Typing logins into the session automatically is part of the Windows version.
                </p>
              ) : (
                <SettingGroup title="Auto-fill">
                  {toggle(
                    'autoFillOnConnect',
                    'Fill automatically after connecting',
                    props.data.ocr
                      ? 'Detects the WALLIX login screens and fills the right login. Machines with their own login always fill.'
                      : 'Windows OCR is not available, so screens are detected by color only.',
                  )}
                  {toggle('autoTypeEnabled', 'Type the machine login on “Target Information Required”')}
                  {toggle('autoTypeDetectScreen', 'Only when a WALLIX login screen is detected')}
                  <SettingRow title="Delay after connecting" hint="Milliseconds before typing starts">
                    <input
                      className="input mono rs-num"
                      type="number"
                      min={0}
                      max={30000}
                      step={250}
                      value={s.autoTypeDelayMs}
                      onChange={(e) => sets('autoTypeDelayMs', Number(e.target.value))}
                    />
                  </SettingRow>
                  <SettingRow title="Key sequence" hint={'{login} {password} {TAB} {ENTER} {DELAY:500}'}>
                    <input className="input mono" value={s.autoTypeSequence} onChange={(e) => sets('autoTypeSequence', e.target.value)} />
                  </SettingRow>
                </SettingGroup>
              )}
            </>
          )}

          {page.id === 'display' && (
            <>
              <SettingGroup title="Screen">
                <SettingRow title="Resolution">
                  <select className="input" value={s.sessionUsesScreenSize ? 'screen' : 'window'} onChange={(e) => sets('sessionUsesScreenSize', e.target.value === 'screen')}>
                    <option value="screen">Full screen size (sharp fullscreen)</option>
                    <option value="window">Follow the tab size</option>
                  </select>
                </SettingRow>
                <SettingRow title="Colors">
                  <select className="input" value={s.colorDepth} onChange={(e) => sets('colorDepth', Number(e.target.value))}>
                    {[32, 24, 16, 15].map((d) => (
                      <option key={d} value={d}>
                        {d}-bit
                      </option>
                    ))}
                  </select>
                </SettingRow>
                {!external && toggle('dynamicResize', 'Change the remote resolution when the tab resizes')}
                {!external && toggle('smartSizing', 'Smart sizing', 'Scale the picture when the resolution cannot change.')}
              </SettingGroup>
              {!external && (
                <SettingGroup title="Picture quality">
                  <SettingRow title="Quality" hint={`${RDP_QUALITIES.find((q) => q.value === (s.quality ?? 'best'))?.hint}. Machines can override it.`}>
                    <select className="input" value={s.quality ?? 'best'} onChange={(e) => sets('quality', e.target.value as RdpQuality)}>
                      {RDP_QUALITIES.map((q) => (
                        <option key={q.value} value={q.value}>
                          {q.label}
                        </option>
                      ))}
                    </select>
                  </SettingRow>
                </SettingGroup>
              )}
            </>
          )}

          {page.id === 'devices' && (
            <>
              <SettingGroup title="Shared with the remote machine">
                {toggle('redirectClipboard', 'Clipboard', 'Needed for pasting and for filling logins.')}
                {toggle('redirectDrives', 'Local drives')}
                {toggle('playAudioLocally', 'Play remote audio on this PC')}
              </SettingGroup>
              <SettingGroup title="Keyboard">
                {!external && toggle('forceUsKeyboard', 'Open sessions with the US keyboard layout', 'Recommended for typing logins.')}
                {toggle('windowsKeysToRemote', 'Send Windows-key combos to the remote machine', 'Alt+Tab and Win go to the session; Ctrl+Alt shortcuts may stop working inside it.')}
              </SettingGroup>
            </>
          )}

          {page.id === 'security' && <SecurityTab data={props.data} s={s} sets={sets} toggle={toggle} onChanged={props.onChanged} />}
        </div>
      </form>
    </Modal>
  );
}

function SecurityTab(props: {
  data: RdpData;
  s: RdpSettings;
  sets<K extends keyof RdpSettings>(k: K, v: RdpSettings[K]): void;
  toggle(k: keyof RdpSettings, title: string, hint?: string): JSX.Element;
  onChanged(): void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const has = props.data.hasMaster;

  const apply = async (remove: boolean) => {
    setMsg(null);
    if (!remove && next !== again) {
      setMsg({ text: 'The two new passwords are different.', error: true });
      return;
    }
    try {
      await rdp.setMasterPassword(current, remove ? '' : next);
      setCurrent('');
      setNext('');
      setAgain('');
      setMsg({ text: remove ? 'Master password removed.' : 'Master password saved.', error: false });
      props.onChanged();
    } catch (e) {
      setMsg({ text: errorMessage(e), error: true });
    }
  };

  return (
    <>
      <SettingGroup title="Master password">
        <div className="rs-status">
          <span className={`rs-badge ${has ? 'on' : ''}`}>{has ? 'On' : 'Off'}</span>
          <span>
            {has
              ? 'Remterm asks for it to open Remote Desktop and to unlock after Ctrl+Alt+L or auto-lock.'
              : 'The vault is encrypted and opens only under your Windows account. A master password also protects it on your unlocked PC.'}
          </span>
        </div>
        {msg && <div className={msg.error ? 'error-box' : 'ok-box'}>{msg.text}</div>}
        {has && (
          <SettingRow title="Current password">
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </SettingRow>
        )}
        <SettingRow title={has ? 'New password' : 'Password'} hint="At least 6 characters">
          <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </SettingRow>
        <SettingRow title="Repeat">
          <input className="input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </SettingRow>
        <div className="rs-actions">
          {has && (
            <button type="button" className="btn sm danger-text" disabled={!current} onClick={() => void apply(true)}>
              Remove it
            </button>
          )}
          <button type="button" className="btn sm" disabled={!next} onClick={() => void apply(false)}>
            {has ? 'Change master password' : 'Set master password'}
          </button>
        </div>
      </SettingGroup>
      <SettingGroup title="Locking">
        <SettingRow title="Auto-lock after" hint={has ? 'Minutes without use; 0 = never' : 'Needs a master password'}>
          <input
            className="input mono rs-num"
            type="number"
            min={0}
            max={600}
            disabled={!has}
            value={props.s.autoLockMinutes}
            onChange={(e) => props.sets('autoLockMinutes', Number(e.target.value))}
          />
        </SettingRow>
        {props.toggle('confirmCloseConnected', 'Ask before closing a connected session')}
      </SettingGroup>
      <SettingGroup title="Troubleshooting">
        {props.toggle('diagEnabled', 'Write a diagnostic log', 'Records screen detection and what is typed (never passwords).')}
        <SettingRow title="Diagnostics folder">
          <button type="button" className="btn sm" onClick={() => void rdp.openDiag()}>
            Open folder
          </button>
        </SettingRow>
        <SettingRow title="Vault file" wide>
          <input className="input mono" readOnly value={props.data.vaultPath} />
        </SettingRow>
      </SettingGroup>
    </>
  );
}

// =============================================================================================== import

export function ImportDialog(props: { data: RdpData; onImported(n: number): void; onClose(): void }) {
  const [text, setText] = useState('');
  const [group, setGroup] = useState('');
  const [cred, setCred] = useState('');
  const [preview, setPreview] = useState<{ count: number; duplicates: number; skipped: number; sample: string[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!text.trim()) {
      setPreview(null);
      return;
    }
    const t = window.setTimeout(() => rdp.importPreview(text).then(setPreview).catch(() => setPreview(null)), 250);
    return () => window.clearTimeout(t);
  }, [text]);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await rdp.import(text, group, cred === NO_CREDENTIAL ? '' : cred);
      props.onImported(r.imported);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Import machines from WALLIX"
      onClose={props.onClose}
      width={720}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !preview?.count} onClick={() => void submit()}>
            Import {preview?.count ? preview.count : ''}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="muted-text">
          Paste the WALLIX target list (copy the rows, or one per line). Every <code>Interactive@NFCore-172.16.170.221:RDP</code> becomes a machine; ones you
          already have are skipped.
        </p>
        {error && <div className="error-box">{error}</div>}
        <textarea className="input mono import-text" autoFocus rows={11} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        <div className={`import-status ${preview?.count ? 'ok' : ''}`}>
          {!preview
            ? 'Nothing to import yet.'
            : `${preview.count} new machine${preview.count === 1 ? '' : 's'}` +
              (preview.duplicates ? `, ${preview.duplicates} already there` : '') +
              (preview.skipped ? `, ${preview.skipped} non-RDP skipped` : '') +
              (preview.sample.length ? ` — ${preview.sample.join(', ')}${preview.count > preview.sample.length ? '…' : ''}` : '')}
        </div>
        <div className="form-grid">
          <label className="field">
            Group
            <input className="input" value={group} onChange={(e) => setGroup(e.target.value)} />
          </label>
          <label className="field">
            Machine login
            <LoginSelect value={cred} onChange={setCred} data={props.data} allowNone={false} />
          </label>
        </div>
      </div>
    </Modal>
  );
}

// =============================================================================================== unlock / lock

export function UnlockForm(props: { onUnlocked(): void; compact?: boolean }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await rdp.unlock(pw);
      setPw('');
      props.onUnlocked();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={`unlock-form ${props.compact ? 'compact' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input className="input" type="password" autoFocus placeholder="Master password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <button className="btn primary" type="submit" disabled={!pw || busy}>
        Unlock
      </button>
      {error && <div className="error-box">{error}</div>}
    </form>
  );
}

/** Covers the whole app after Ctrl+Alt+L or auto-lock; sessions stay connected behind it. */
export function LockScreen(props: { onUnlocked(): void }) {
  useCover();
  return (
    <div className="lock-screen">
      <div className="lock-card">
        <div className="lock-ico">
          <Icon name="lock" size={30} />
        </div>
        <h2>Remterm is locked</h2>
        <p className="muted-text">Sessions stay connected in the background.</p>
        <UnlockForm onUnlocked={props.onUnlocked} />
      </div>
    </div>
  );
}
