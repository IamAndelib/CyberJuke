import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

export interface RailItem<T extends string> {
  id: T;
  label: ComponentChildren;
  testid?: string;
}

/**
 * Slim text rail: a row of text options, the current one underlined.
 *
 * - `kind`: 'tabs' (role tablist/tab, aria-selected) or 'radio' (radiogroup/radio,
 *   aria-checked).
 * - `variant`: 'tab' (display font, uppercase, solid 2px underline: the primary choice)
 *   or 'filter' (UI font, lowercase, dithered underline: a secondary choice).
 * - Roving tabindex: one stop per rail; arrow keys / Home / End move and select.
 * - `keepFocus`: pressing an item does not take focus (keeps the keyboard up in Search).
 */
export function Rail<T extends string>({
  items,
  value,
  onChange,
  kind = 'tabs',
  variant = 'tab',
  label,
  testid,
  keepFocus,
  class: cls,
}: {
  items: readonly RailItem<T>[];
  value: T;
  onChange: (id: T) => void;
  kind?: 'tabs' | 'radio';
  variant?: 'tab' | 'filter';
  label: string;
  testid?: string;
  keepFocus?: boolean;
  class?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabs = kind === 'tabs';
  const move = (e: KeyboardEvent, i: number) => {
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    if (j < 0) return;
    e.preventDefault();
    onChange(items[j].id);
    const el = refs.current[j];
    el?.focus();
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };
  return (
    <div
      class={`rail rail-${variant}` + (cls ? ' ' + cls : '')}
      role={tabs ? 'tablist' : 'radiogroup'}
      aria-label={label}
      data-testid={testid}
    >
      {items.map((it, i) => {
        const on = it.id === value;
        return (
          <button
            key={it.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role={tabs ? 'tab' : 'radio'}
            aria-selected={tabs ? on : undefined}
            aria-checked={tabs ? undefined : on}
            tabIndex={on ? 0 : -1}
            class={'rail-item' + (on ? ' on' : '')}
            onPointerDown={keepFocus ? (e) => e.preventDefault() : undefined}
            onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}
            onClick={() => onChange(it.id)}
            onKeyDown={(e) => move(e, i)}
            data-testid={it.testid}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Row holding one or more rails; scrolls sideways when they don't fit, with a fade on
 * the edge that has more. `ruled` draws the rule the underline sits on (outside a top bar).
 */
export function RailRow({ children, ruled, class: cls, testid }: { children: ComponentChildren; ruled?: boolean; class?: string; testid?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const frame = useRef(0);
  /** Re-measure on the next frame (at most once a frame, however many scroll events). */
  const update = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const r = el.current;
      if (r) setMore(r.scrollLeft + r.clientWidth < r.scrollWidth - 2);
    });
  };
  useEffect(() => {
    update();
    const r = el.current;
    let ro: ResizeObserver | null = null;
    if (r && typeof ResizeObserver === 'function') {
      // The row and its rails: a rail growing (a label changing) changes the fade too.
      ro = new ResizeObserver(update);
      ro.observe(r);
      for (const c of Array.from(r.children)) ro.observe(c);
    }
    return () => {
      ro?.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, []);
  return (
    <div
      ref={el}
      class={'rail-row' + (ruled ? ' ruled' : '') + (more ? ' more' : '') + (cls ? ' ' + cls : '')}
      onScroll={update}
      data-testid={testid}
    >
      {children}
    </div>
  );
}

/** Thin dotted divider between two rails in one row. */
export function RailSep() {
  return <span class="rail-sep" aria-hidden="true" />;
}
