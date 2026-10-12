import { useState } from 'react';
import { SCHEMES } from '../themes';
import type { EnvVar, Host, Identity, KeyItem, Proxy } from '../types';
import { Icon } from './Icon';
import { Modal } from './Modal';

/** Name/value rows for environment variables. */
export function EnvVarsEditor({ value, onChange }: { value: EnvVar[]; onChange(v: EnvVar[]): void }) {
  const set = (i: number, patch: Partial<EnvVar>) => onChange(value.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <div className="kv-list">
      {value.map((v, i) => (
        <div className="kv-row" key={i}>
          <input className="input mono" placeholder="NAME" value={v.name} onChange={(e) => set(i, { name: e.target.value.replace(/\s/g, '') })} />
          <input className="input mono" placeholder="value" value={v.value} onChange={(e) => set(i, { value: e.target.value })} />
          <button type="button" className="icon-btn sm danger" title="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
      <button type="button" className="btn sm" onClick={() => onChange([...value, { name: '', value: '' }])}>
        <Icon name="plus" size={12} /> Add variable
      </button>
    </div>
  );
}

const EMPTY_PROXY: Proxy = { type: 'socks5', host: '', port: 1080, user: '', hasSecret: false };

/** Optional SOCKS5/HTTP proxy for the first hop. */
export function ProxyEditor(props: {
  value: Proxy | null | undefined;
  onChange(p: Proxy | null): void;
  password: string;
  onPassword(p: string): void;
}) {
  const p = props.value;
  if (!p) {
    return (
      <button type="button" className="btn sm" onClick={() => props.onChange({ ...EMPTY_PROXY })}>
        <Icon name="plus" size={12} /> Use a proxy
      </button>
    );
  }
  const set = (patch: Partial<Proxy>) => props.onChange({ ...p, ...patch });
  return (
    <div className="proxy-grid">
      <select className="input" value={p.type} onChange={(e) => set({ type: e.target.value as Proxy['type'], port: e.target.value === 'http' ? 8080 : 1080 })}>
        <option value="socks5">SOCKS5</option>
        <option value="http">HTTP (CONNECT)</option>
      </select>
      <input className="input mono" placeholder="proxy.example.com" value={p.host} onChange={(e) => set({ host: e.target.value })} />
      <input className="input mono port" type="number" value={p.port} onChange={(e) => set({ port: Number(e.target.value) })} />
      <input className="input" placeholder="Username (optional)" value={p.user} onChange={(e) => set({ user: e.target.value })} />
      <input
        className="input"
        type="password"
        placeholder={p.hasSecret ? '•••••• saved — leave empty to keep' : 'Password (optional)'}
        value={props.password}
        onChange={(e) => props.onPassword(e.target.value)}
      />
      <button type="button" className="btn sm" onClick={() => props.onChange(null)}>
        Remove proxy
      </button>
    </div>
  );
}

/** Comma/Enter separated tags with suggestions. */
export function TagInput({ value, onChange, suggestions }: { value: string[]; onChange(v: string[]): void; suggestions: string[] }) {
  const [text, setText] = useState('');
  const add = (t: string) => {
    const tag = t.trim();
    if (tag && !value.some((v) => v.toLowerCase() === tag.toLowerCase())) onChange([...value, tag]);
    setText('');
  };
  return (
    <div className="tag-input">
      {value.map((t) => (
        <span key={t} className="tag">
          {t}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
      <input
        list="tag-suggestions"
        placeholder={value.length ? '' : 'linux, docker, client-a…'}
        value={text}
        onChange={(e) => {
          if (e.target.value.endsWith(',')) add(e.target.value.slice(0, -1));
          else setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(text);
          } else if (e.key === 'Backspace' && !text && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => text && add(text)}
      />
      <datalist id="tag-suggestions">
        {suggestions.filter((s) => !value.includes(s)).map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}

export function SchemeSelect({ value, onChange, inheritLabel }: { value: string; onChange(v: string): void; inheritLabel: string }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{inheritLabel}</option>
      {SCHEMES.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

export function IdentitySelect(props: { value: string; onChange(v: string): void; identities: Identity[]; inheritLabel: string }) {
  return (
    <select className="input" value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      <option value="">{props.inheritLabel}</option>
      {props.identities.map((i) => (
        <option key={i.id} value={i.id}>
          {i.label} ({i.username})
        </option>
      ))}
    </select>
  );
}

export function KeySelect(props: { value: string; onChange(v: string): void; keys: KeyItem[]; emptyLabel: string }) {
  return (
    <select className="input" value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      <option value="">{props.emptyLabel}</option>
      {props.keys.map((k) => (
        <option key={k.id} value={k.id}>
          {k.label} — {k.type.replace('ssh-', '')}
          {k.certificate ? ' + certificate' : ''}
        </option>
      ))}
    </select>
  );
}

export function HostSelect(props: { value: string; onChange(v: string): void; hosts: Host[]; emptyLabel: string; exclude?: string }) {
  return (
    <select className="input" value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      <option value="">{props.emptyLabel}</option>
      {props.hosts
        .filter((h) => h.id !== props.exclude && (h.protocol || 'ssh') === 'ssh')
        .map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
            {h.group ? ` — ${h.group}` : ''}
          </option>
        ))}
    </select>
  );
}

/** One-line text question (names, comments, paths). */
export function PromptDialog(props: {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  multiline?: boolean;
  onSubmit(value: string): void | Promise<void>;
  onCancel(): void;
}) {
  const [value, setValue] = useState(props.initial ?? '');
  const [error, setError] = useState('');
  const submit = async () => {
    try {
      await props.onSubmit(value);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };
  return (
    <Modal
      title={props.title}
      onClose={props.onCancel}
      width={440}
      footer={
        <>
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn primary" type="submit" form="prompt-form">
            {props.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <form
        id="prompt-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error && <div className="error-box">{error}</div>}
        <label className="field">
          {props.label}
          {props.multiline ? (
            <textarea className="input" rows={3} autoFocus value={value} placeholder={props.placeholder} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <input
              className="input"
              autoFocus
              value={value}
              placeholder={props.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onFocus={(e) => {
                // Select the name without its extension, like Explorer.
                const dot = e.target.value.lastIndexOf('.');
                e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
              }}
            />
          )}
        </label>
      </form>
    </Modal>
  );
}
