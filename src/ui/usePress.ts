/**
 * Visible press feedback for buttons that act on a quick tap (U3). A CSS `:active` press
 * often never paints: the finger is up before the next frame. `usePress` adds `.pressed`
 * on pointerdown and keeps it for at least PRESS_MS, so the button visibly sinks into its
 * shadow and eases back. Skipped with reduced motion (the plain `:active` style remains).
 *
 * `usePressThen` is for a button that replaces the screen it sits on (Settings, a Back
 * arrow): acting at once would hide the press before it painted. Like Android's View, which
 * shows the pressed state before it performs the click, it acts once the press has shown.
 * A tap or key that comes sooner runs the waiting action first, so it never lands on the
 * screen the next tap opened.
 */
import type { RefObject } from 'preact';
import { useCallback, useEffect, useRef } from 'preact/hooks';
import { reducedMotion } from '../core/motion';

const PRESS_MS = 120;

/** When each element's last press began (performance.now()). */
const pressedAt = new WeakMap<HTMLElement, number>();
/** Buttons whose action waits on their press (usePressThen): the action lifts the press. */
const held = new WeakSet<HTMLElement>();
/** The usePressThen action waiting on its press, if any. */
let pending: (() => void) | null = null;

/** Runs the waiting action now, before whatever comes next. */
function flush(): void {
  pending?.();
}

if (typeof document !== 'undefined') {
  // Capture phase: before the next tap's own handlers (a tab, another Back) see it.
  document.addEventListener('pointerdown', flush, { capture: true, passive: true });
  document.addEventListener('keydown', flush, true);
}

export function usePress(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let downAt = 0;
    let timer: ReturnType<typeof setTimeout> | 0 = 0;
    const down = (e: PointerEvent) => {
      if ((e.pointerType === 'mouse' && e.button !== 0) || reducedMotion()) return;
      clearTimeout(timer);
      downAt = performance.now();
      pressedAt.set(el, downAt);
      el.classList.add('pressed');
    };
    const up = () => {
      if (!downAt) return;
      const left = Math.max(0, PRESS_MS - (performance.now() - downAt));
      downAt = 0;
      timer = setTimeout(() => {
        if (!held.has(el)) el.classList.remove('pressed');
      }, left);
    };
    el.addEventListener('pointerdown', down, { passive: true });
    for (const t of ['pointerup', 'pointercancel', 'pointerleave'] as const) el.addEventListener(t, up, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener('pointerdown', down);
      for (const t of ['pointerup', 'pointercancel', 'pointerleave'] as const) el.removeEventListener(t, up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Mount-only: `ref` is a stable ref object.
  }, []);
}

/**
 * A ref and a click handler for a button whose `action` replaces the screen it is on. After a
 * quick tap the action waits until the press has shown for PRESS_MS (at most that long after
 * the finger went down); after a long press, or a click with no press (keyboard, TalkBack,
 * reduced motion), it runs at once. A second click while one waits does nothing, and any
 * later tap or key runs the waiting action first.
 */
export function usePressThen<T extends HTMLElement>(action: () => void): { ref: RefObject<T | null>; onClick: () => void } {
  const ref = useRef<T>(null);
  usePress(ref);
  const latest = useRef(action);
  latest.current = action;
  const waiting = useRef(false);
  const onClick = useCallback(() => {
    if (waiting.current) return;
    const el = ref.current;
    const at = el ? pressedAt.get(el) : undefined;
    const wait = at === undefined ? 0 : PRESS_MS - (performance.now() - at);
    flush();
    if (wait <= 0 || !el) return latest.current();
    waiting.current = true;
    held.add(el);
    const run = () => {
      clearTimeout(timer);
      pending = null;
      waiting.current = false;
      held.delete(el);
      latest.current();
      // In the same task as the action, so no frame shows the button unpressed before it.
      el.classList.remove('pressed');
    };
    const timer = setTimeout(run, wait);
    pending = run;
  }, []);
  return { ref, onClick };
}
