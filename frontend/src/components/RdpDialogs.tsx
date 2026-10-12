import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../api';
import { bastionLogin, makeTarget, rdp, useCover } from '../rdp';
import { NO_CREDENTIAL, type Bastion, type Machine, type RdpCredential, type RdpData, type RdpSettings } from '../types';
import { Icon } from './Icon';
import { Modal } from './Modal';

export const EMPTY_MACHINE: Machine = {
  id: '',
  name: '',
  ip: '',
  target: '',
  group: '',
  mode: 'bastion',
  credentialId: null,
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
      {props.allowNone !== false && <option value={NO_CREDENTIAL}>None — I type it myself</option>}
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

export function MachineDialog(props: {
  machine: Machine | null;
  defaultGroup?: string;
  data: RdpData;
  onSaved(m: Machine, connect: boolean): void;
  onClose(): void;
}) {
  const [m, setM] = useState<Machine>(() => ({ ...EMPTY_MACHINE, group: props.defaultGroup ?? '', ...props.machine }));
  const [targetEdited, setTargetEdited] = useState(() => !!props.machine?.target && props.machine.target !== makeTarget(props.machine.name, props.machine.ip));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connectAfter, setConnectAfter] = useState(false);
  const groups = useMemo(() => [...new Set(props.data.machines.map((x) => x.group).filter(Boolean))].sort(), [props.data.machines]);
  const set = <K extends keyof Machine>(k: K, v: Machine[K]) => setM((p) => ({ ...p, [k]: v }));

  // The WALLIX target follows name + IP until it is edited by hand.
  const setNameOrIp = (patch: Partial<Machine>) =>
    setM((p) => {
      const n = { ...p, ...patch };
      if (!targetEdited && n.name.trim()) n.target = makeTarget(n.name, n.ip);
      return n;
    });

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const saved = await rdp.saveMachine(m);
      props.onSaved(saved, connectAfter);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={props.machine?.id ? `Edit ${props.machine.name}` : 'New Remote Desktop machine'}
      onClose={props.onClose}
      width={600}
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
        <label className="field span2">
          Connect
          <div className="env-pick">
            <button type="button" className={`env-chip ${m.mode === 'bastion' ? 'on proto' : ''}`} onClick={() => set('mode', 'bastion')}>
              Through WALLIX bastion
            </button>
            <button type="button" className={`env-chip ${m.mode === 'direct' ? 'on proto' : ''}`} onClick={() => set('mode', 'direct')}>
              Direct RDP
            </button>
          </div>
        </label>
        <label className="field">
          Name
          <input className="input" autoFocus placeholder="NFCore" value={m.name} onChange={(e) => setNameOrIp({ name: e.target.value })} />
        </label>
        <label className="field">
          IP / host
          <input
            className="input mono"
            placeholder={m.mode === 'direct' ? '10.0.0.5 or 10.0.0.5:3390' : '172.16.170.221'}
            value={m.ip}
            onChange={(e) => setNameOrIp({ ip: e.target.value })}
          />
        </label>
        {m.mode === 'bastion' && (
          <label className="field span2">
            WALLIX target <span className="hint">— exactly as in the WALLIX list; empty opens the list</span>
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
        <label className="field">
          Group
          <input className="input" list="rdp-groups" placeholder="Ungrouped" value={m.group} onChange={(e) => set('group', e.target.value)} />
          <datalist id="rdp-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
        <label className="field">
          {m.mode === 'bastion' ? 'Machine login (step 2)' : 'Login'}
          <LoginSelect value={m.credentialId ?? ''} onChange={(v) => set('credentialId', v || null)} data={props.data} />
        </label>
        <label className="field">
          Auto-fill
          <select className="input" value={m.autoType} onChange={(e) => set('autoType', e.target.value as Machine['autoType'])}>
            <option value="auto">Automatic</option>
            <option value="always">Always</option>
            <option value="never">Never</option>
          </select>
        </label>
        <label className="check" style={{ alignSelf: 'end', paddingBottom: 8 }}>
          <input type="checkbox" checked={m.favorite} onChange={(e) => set('favorite', e.target.checked)} />
          ★ Favorite
        </label>
        <label className="field span2">
          Notes
          <textarea className="input" rows={2} value={m.notes} onChange={(e) => set('notes', e.target.value)} />
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
        Logins typed on WALLIX's <b>Target Information Required</b> screen (step 2) or on a machine's own login screen. In a session press{' '}
        <kbd>Ctrl+Alt+K</kbd> to pick one. Stored encrypted (AES-256, bound to your Windows account).
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

export type RdpSettingsTab = 'bastion' | 'fill' | 'display' | 'security';

export function RdpSettingsDialog(props: { data: RdpData; tab?: RdpSettingsTab; onLogins(): void; onChanged(): void; onClose(): void }) {
  const [tab, setTab] = useState<RdpSettingsTab>(props.tab ?? 'bastion');
  const [b, setB] = useState<Bastion>({ ...props.data.bastion });
  const [s, setS] = useState<RdpSettings>({ ...props.data.settings });
  const [primaryPassword, setPrimaryPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const setb = <K extends keyof Bastion>(k: K, v: Bastion[K]) => setB((p) => ({ ...p, [k]: v }));
  const sets = <K extends keyof RdpSettings>(k: K, v: RdpSettings[K]) => setS((p) => ({ ...p, [k]: v }));
  const example = bastionLogin(b.loginTemplate, 'Interactive@NFCore-172.16.170.221:RDP', b.authorization, b.primaryUser || 'user');

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

  const check = (k: keyof RdpSettings, title: string, hint?: string) => (
    <label className="toggle span2">
      <input type="checkbox" checked={!!s[k]} onChange={(e) => sets(k, e.target.checked as never)} />
      <span>
        <b>{title}</b>
        {hint && <span className="hint">{hint}</span>}
      </span>
    </label>
  );

  return (
    <Modal
      title="Remote Desktop settings"
      onClose={props.onClose}
      width={640}
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
      <div className="dlg-tabs" role="tablist">
        {(
          [
            ['bastion', 'WALLIX bastion'],
            ['fill', 'Logins & auto-fill'],
            ['display', 'Display & devices'],
            ['security', 'Security'],
          ] as [RdpSettingsTab, string][]
        )
          .filter(([id]) => !(props.data.external && id === 'security'))
          .map(([id, label]) => (
          <button key={id} type="button" role="tab" className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <form
        id="rdp-settings-form"
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {error && <div className="error-box span2">{error}</div>}

        {tab === 'bastion' && (
          <>
            <p className="hint span2" style={{ margin: 0 }}>
              Step 1: the bastion you would open with mstsc. Machines set to “direct” ignore this.
            </p>
            <label className="field">
              Bastion address
              <input className="input mono" placeholder="10.10.10.10" value={b.host} onChange={(e) => setb('host', e.target.value)} />
            </label>
            <label className="field">
              Port
              <input className="input mono" type="number" min={1} max={65535} value={b.port} onChange={(e) => setb('port', Number(e.target.value))} />
            </label>
            <label className="field">
              Primary login
              <input className="input" value={b.primaryUser} onChange={(e) => setb('primaryUser', e.target.value)} />
            </label>
            <label className="field">
              Primary password
              <PasswordInput value={primaryPassword} onChange={setPrimaryPassword} saved={b.hasPassword} />
            </label>
            <label className="field">
              Authorization <span className="hint">— from the WALLIX list (optional)</span>
              <input className="input" value={b.authorization} onChange={(e) => setb('authorization', e.target.value)} />
            </label>
            <label className="field">
              Login format
              <input className="input mono" value={b.loginTemplate} placeholder="{target}:{auth}:{user}" onChange={(e) => setb('loginTemplate', e.target.value)} />
            </label>
            <div className="field span2">
              Example login
              <code className="login-example">{example}</code>
            </div>
            <label className="toggle span2">
              <input type="checkbox" checked={b.interactiveLoginUsesTarget} onChange={(e) => setb('interactiveLoginUsesTarget', e.target.checked)} />
              <span>
                <b>On WALLIX's own login page, type the full target string</b>
                <span className="hint">Off: types your primary login and you pick from the list. On: goes straight to the machine.</span>
              </span>
            </label>
            <label className="toggle span2">
              <input type="checkbox" checked={b.useNla} onChange={(e) => setb('useNla', e.target.checked)} />
              <span>
                <b>Use NLA (CredSSP) for the bastion login</b>
              </span>
            </label>
            <label className="field span2">
              Server certificate
              <select className="input" value={b.authLevel} onChange={(e) => setb('authLevel', Number(e.target.value))}>
                <option value={0}>Connect, pin the server key on first use (recommended)</option>
                <option value={1}>Require a valid certificate</option>
                <option value={2}>Warn me (Windows dialog)</option>
              </select>
            </label>
          </>
        )}

        {tab === 'fill' && (
          <>
            <div className="span2 row-between">
              <span className="hint">
                {props.data.credentials.length} saved login{props.data.credentials.length === 1 ? '' : 's'}. In a session, <kbd>Ctrl+Alt+K</kbd> picks one
                and types it on the current screen.
              </span>
              <button type="button" className="btn sm" onClick={props.onLogins}>
                <Icon name="key" size={12} /> Edit logins…
              </button>
            </div>
            {props.data.external ? (
              <p className="hint span2" style={{ margin: 0 }}>
                On this computer sessions open in Microsoft's Windows App: the server and the WALLIX login are filled in and the password is put on the
                clipboard for ⌘V. Typing logins into the session automatically is part of the Windows version.
              </p>
            ) : (
              <>
                {check('autoFillOnConnect', 'Fill automatically after connecting', props.data.ocr
                  ? 'Detects the WALLIX login screens (Windows OCR) and fills the right login. Machines with their own login always auto-fill.'
                  : 'Windows OCR is not available, so screens are detected by color only.')}
                {check('autoTypeEnabled', 'Type the machine login on “Target Information Required”')}
                {check('autoTypeDetectScreen', 'Only when a WALLIX login screen is detected')}
                <label className="field">
                  Delay after connect (ms)
                  <input className="input mono" type="number" min={0} max={30000} step={250} value={s.autoTypeDelayMs} onChange={(e) => sets('autoTypeDelayMs', Number(e.target.value))} />
                </label>
                <label className="field">
                  Key sequence <span className="hint">{'{login} {password} {TAB} {ENTER} {DELAY:500}'}</span>
                  <input className="input mono" value={s.autoTypeSequence} onChange={(e) => sets('autoTypeSequence', e.target.value)} />
                </label>
              </>
            )}
          </>
        )}

        {tab === 'display' && (
          <>
            <label className="field">
              Resolution
              <select className="input" value={s.sessionUsesScreenSize ? 'screen' : 'window'} onChange={(e) => sets('sessionUsesScreenSize', e.target.value === 'screen')}>
                <option value="screen">Full screen size (sharp fullscreen)</option>
                <option value="window">Follow the tab size</option>
              </select>
            </label>
            <label className="field">
              Colors
              <select className="input" value={s.colorDepth} onChange={(e) => sets('colorDepth', Number(e.target.value))}>
                {[32, 24, 16, 15].map((d) => (
                  <option key={d} value={d}>
                    {d}-bit
                  </option>
                ))}
              </select>
            </label>
            {!props.data.external && check('dynamicResize', 'Change the remote resolution when the tab resizes')}
            {!props.data.external && check('smartSizing', 'Smart sizing', 'Scale the picture when the resolution cannot change.')}
            {check('redirectClipboard', 'Share the clipboard', 'Needed for pasting and for filling logins.')}
            {check('redirectDrives', 'Share local drives')}
            {check('playAudioLocally', 'Play remote audio on this PC')}
            {!props.data.external && check('forceUsKeyboard', 'Open sessions with the US keyboard layout', 'Recommended for typing logins.')}
            {check('windowsKeysToRemote', 'Send Windows-key combos (Alt+Tab, Win) to the remote machine', 'Ctrl+Alt shortcuts may stop working inside sessions.')}
          </>
        )}

        {tab === 'security' && <SecurityTab data={props.data} s={s} sets={sets} check={check} onChanged={props.onChanged} />}
      </form>
    </Modal>
  );
}

function SecurityTab(props: {
  data: RdpData;
  s: RdpSettings;
  sets<K extends keyof RdpSettings>(k: K, v: RdpSettings[K]): void;
  check(k: keyof RdpSettings, title: string, hint?: string): JSX.Element;
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
      <div className="field span2">
        Master password
        <span className="hint">
          {has
            ? 'Set. Remterm asks for it to open Remote Desktop and to unlock after Ctrl+Alt+L or auto-lock.'
            : 'Not set. The vault is still encrypted and only opens under your Windows account. A master password also protects it on your unlocked PC.'}
        </span>
      </div>
      {msg && <div className={`span2 ${msg.error ? 'error-box' : 'ok-box'}`}>{msg.text}</div>}
      {has && (
        <label className="field span2">
          Current password
          <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
      )}
      <label className="field">
        {has ? 'New password' : 'Password'}
        <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <label className="field">
        Repeat
        <input className="input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </label>
      <div className="span2 row-btns">
        <button type="button" className="btn" disabled={!next} onClick={() => void apply(false)}>
          {has ? 'Change master password' : 'Set master password'}
        </button>
        {has && (
          <button type="button" className="btn danger-text" disabled={!current} onClick={() => void apply(true)}>
            Remove it
          </button>
        )}
      </div>
      <div className="divider span2" />
      <label className="field">
        Auto-lock after (minutes, 0 = never)
        <input
          className="input mono"
          type="number"
          min={0}
          max={600}
          disabled={!has}
          value={props.s.autoLockMinutes}
          onChange={(e) => props.sets('autoLockMinutes', Number(e.target.value))}
        />
      </label>
      <div />
      {props.check('confirmCloseConnected', 'Ask before closing a connected session')}
      {props.check('diagEnabled', 'Write a diagnostic log', 'Records screen detection and what is typed (never passwords). For troubleshooting auto-fill.')}
      <div className="span2 row-btns">
        <button type="button" className="btn sm" onClick={() => void rdp.openDiag()}>
          Open diagnostics folder
        </button>
      </div>
      <label className="field span2">
        Vault file
        <input className="input mono" readOnly value={props.data.vaultPath} />
      </label>
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
            Group <span className="hint">— empty: grouped by name (NF…, IRPT…)</span>
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
