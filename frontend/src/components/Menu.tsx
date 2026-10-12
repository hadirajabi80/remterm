import { useEffect, useRef, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  hint?: string;
  icon?: ReactNode;
  onClick(): void;
}

/** Small dropdown anchored below its parent (which must be position: relative). */
export function Menu({ items, onClose, align = 'left' }: { items: (MenuItem | 'sep')[]; onClose(): void; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
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
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  return (
    <div ref={ref} className={`menu ${align}`} role="menu">
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className="menu-item"
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
