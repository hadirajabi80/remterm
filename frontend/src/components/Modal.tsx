import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useCover } from '../rdp';
import { Icon } from './Icon';

/** Open overlays, innermost last: only the top one reacts to Esc. */
const stack: symbol[] = [];

/**
 * Esc closes this overlay only when it is the topmost one (stacked dialogs
 * close one at a time). On unmount the element focused before it opened
 * (e.g. the terminal) gets the focus back.
 */
export function useOverlayEscape(onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const token = Symbol('overlay');
    const prev = document.activeElement as HTMLElement | null;
    stack.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stack[stack.length - 1] === token) {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
      const now = document.activeElement;
      if ((!now || now === document.body) && prev?.isConnected) prev.focus();
    };
  }, []);
}

export function Modal(props: {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useCover();
  useOverlayEscape(props.onClose);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" style={{ width: props.width ?? 460 }} role="dialog" aria-modal aria-label={props.title}>
        <header className="modal-head">
          <h2>{props.title}</h2>
          <button className="icon-btn sm" onClick={props.onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
        {props.footer && <footer className="modal-foot">{props.footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog(props: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <Modal
      title={props.title}
      onClose={props.onCancel}
      width={400}
      footer={
        <>
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button className={`btn ${props.danger ? 'danger-solid' : 'primary'}`} autoFocus onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <p className="muted-text">{props.message}</p>
    </Modal>
  );
}

export function AuthDialog(props: {
  kind: 'password' | 'passphrase';
  target: string;
  error: string;
  canSave: boolean;
  onSubmit(password: string, save: boolean): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState('');
  const [save, setSave] = useState(true);
  const label = props.kind === 'passphrase' ? 'Key passphrase' : 'Password';
  return (
    <Modal
      title={props.kind === 'passphrase' ? 'Unlock private key' : 'Authentication required'}
      onClose={props.onCancel}
      width={420}
      footer={
        <>
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn primary" type="submit" form="auth-form" disabled={!value}>
            Connect
          </button>
        </>
      }
    >
      <form
        id="auth-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) props.onSubmit(value, props.canSave && save);
        }}
      >
        <div className="auth-target">
          <Icon name={props.kind === 'passphrase' ? 'key' : 'lock'} />
          <span>{props.target}</span>
        </div>
        {props.error && <div className="error-box">{props.error}</div>}
        <label className="field">
          {label}
          <input className="input" type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {props.canSave && (
          <label className="check">
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
            Remember in the system credential store
          </label>
        )}
      </form>
    </Modal>
  );
}
