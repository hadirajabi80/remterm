import { useId } from 'react';
import type { PasswordItem } from '../types';

/** A password can be chosen, created or edited where it is needed. */
export function PasswordSelect(props: {
  label: string;
  value: string;
  items: PasswordItem[];
  emptyLabel: string;
  legacyLabel?: string;
  onChange(id: string): void;
  onManage(item: PasswordItem | null, onSaved: (item: PasswordItem) => void): void;
}) {
  const id = useId();
  const selected = props.items.find((p) => p.id === props.value);
  return (
    <div className="field span2">
      <label htmlFor={id}>{props.label}</label>
      <div className="password-select-row">
        <select id={id} className="input" value={props.value} onChange={(e) => props.onChange(e.target.value)}>
          <option value="">{props.emptyLabel}</option>
          {props.legacyLabel && <option value="__host__">{props.legacyLabel}</option>}
          {props.value && props.value !== '__host__' && !selected && <option value={props.value}>Password unavailable — choose another</option>}
          {props.items.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
        <button className="btn sm" type="button" onClick={() => props.onManage(null, (p) => props.onChange(p.id))}>+ Save new</button>
        {selected && <button className="btn sm" type="button" onClick={() => props.onManage(selected, (p) => props.onChange(p.id))}>Edit</button>}
      </div>
    </div>
  );
}
