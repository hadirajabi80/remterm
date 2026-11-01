import { useId, useLayoutEffect, useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

type SuggestInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'list' | 'onSelect'> & {
  suggestions: string[];
  onSelect: (value: string) => void;
  onEnter?: (event: KeyboardEvent<HTMLInputElement>) => void;
};

/** Free text input with a themed, keyboard-accessible suggestion list. */
export function SuggestInput({ suggestions, onSelect, onEnter, onFocus, onBlur, onChange, onKeyDown, ...inputProps }: SuggestInputProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 240 });
  const value = String(inputProps.value ?? '');
  const options = useMemo(() => {
    const seen = new Set<string>();
    return suggestions.filter((item) => {
      const normalized = item.trim().toLocaleLowerCase();
      if (!normalized || seen.has(normalized) || normalized === value.trim().toLocaleLowerCase()) return false;
      seen.add(normalized);
      return !value.trim() || normalized.includes(value.trim().toLocaleLowerCase());
    });
  }, [suggestions, value]);

  useLayoutEffect(() => {
    if (!open || !inputRef.current) return;
    const update = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = Math.max(0, window.innerHeight - rect.bottom - 8);
      const above = Math.max(0, rect.top - 8);
      const placeAbove = below < 120 && above > below;
      const maxHeight = Math.min(240, placeAbove ? above : below);
      setPosition({ left: rect.left, top: placeAbove ? Math.max(8, rect.top - maxHeight) : rect.bottom, width: rect.width, maxHeight });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, options.length]);

  useLayoutEffect(() => {
    if (open && active >= 0) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, id, open]);

  const choose = (option: string) => {
    setOpen(false);
    setActive(-1);
    onSelect(option);
  };

  const list = open && options.length > 0 && createPortal(
    <div id={id} className="suggest-list" role="listbox" style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}>
      {options.map((option, index) => (
        <div
          key={option}
          id={`${id}-option-${index}`}
          className={`suggest-option ${index === active ? 'active' : ''}`}
          role="option"
          aria-selected={index === active}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => choose(option)}
        >
          {option}
        </div>
      ))}
    </div>,
    document.body,
  );

  return <>
    <input
      {...inputProps}
      ref={inputRef}
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open && options.length > 0}
      aria-controls={open && options.length > 0 ? id : undefined}
      aria-activedescendant={active >= 0 && options[active] ? `${id}-option-${active}` : undefined}
      onFocus={(event) => {
        setOpen(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setOpen(false);
        setActive(-1);
        onBlur?.(event);
      }}
      onChange={(event) => {
        setOpen(true);
        setActive(-1);
        onChange?.(event);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          onKeyDown?.(event);
          return;
        }
        if (event.key === 'ArrowDown' && options.length) {
          event.preventDefault();
          setOpen(true);
          setActive((current) => (current + 1) % options.length);
          return;
        }
        if (event.key === 'ArrowUp' && options.length) {
          event.preventDefault();
          setOpen(true);
          setActive((current) => (current <= 0 ? options.length - 1 : current - 1));
          return;
        }
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          setActive(-1);
          return;
        }
        if (event.key === 'Enter') {
          if (open && active >= 0 && options[active]) {
            event.preventDefault();
            choose(options[active]);
            return;
          }
          onEnter?.(event);
        }
        onKeyDown?.(event);
      }}
    />
    {list}
  </>;
}
