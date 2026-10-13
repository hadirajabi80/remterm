import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { GROUP_COLORS } from '../colors';
import { useCoverRect } from '../rdp';

export interface MenuItem {
  label: string;
  hint?: string;
  icon?: ReactNode;
  disabled?: boolean;
  onClick(): void;
}

/** A row of color dots (group colors); null = no color. */
export interface MenuSwatches {
  swatches: true;
  label: string;
  value: string | null;
  onPick(id: string | null): void;
}

export type MenuEntry = MenuItem | MenuSwatches | 'sep';

/**
 * Small dropdown. Anchored below its parent (which must be position:
 * relative), or at a screen point (`at`, for right-click menus).
 */
export function Menu({
  items,
  onClose,
  align = 'left',
  at,
}: {
  items: MenuEntry[];
  onClose(): void;
  align?: 'left' | 'right';
  at?: { x: number; y: number };
}) {
  const ref = useRef<HTMLDivElement>(null);
  useCoverRect(ref);
  const [pos, setPos] = useState(at);

  useLayoutEffect(() => {
    if (!at || !ref.current) return;
    // Keep the menu inside the window.
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(at.x, window.innerWidth - r.width - 6), y: Math.min(at.y, window.innerHeight - r.height - 6) });
  }, [at]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className={`menu ${at ? 'at' : align}`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="menu-sep" />
        ) : 'swatches' in it ? (
          <div key={i} className="menu-swatches">
            <span className="menu-label">{it.label}</span>
            <div className="swatch-row">
              <button
                className={`swatch none ${it.value ? '' : 'on'}`}
                title="No color"
                onClick={() => {
                  onClose();
                  it.onPick(null);
                }}
              />
              {GROUP_COLORS.map((c) => (
                <button
                  key={c.id}
                  className={`swatch ${it.value === c.id ? 'on' : ''}`}
                  title={c.label}
                  style={{ background: c.css }}
                  onClick={() => {
                    onClose();
                    it.onPick(c.id);
                  }}
                />
              ))}
            </div>
          </div>
        ) : (
          <button
            key={i}
            role="menuitem"
            className="menu-item"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            <span className="menu-ico">{it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
