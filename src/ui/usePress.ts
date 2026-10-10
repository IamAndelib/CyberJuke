/**
 * Visible press feedback for buttons that act on a quick tap (U3). A CSS `:active` press
 * often never paints: the finger is up before the next frame. `usePress` adds `.pressed`
 * on pointerdown and keeps it for at least PRESS_MS, so the button visibly sinks into its
 * shadow and eases back. Skipped with reduced motion (the plain `:active` style remains).
 */
import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';
import { reducedMotion } from '../core/motion';

const PRESS_MS = 120;

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
      el.classList.add('pressed');
    };
    const up = () => {
      if (!downAt) return;
      const left = Math.max(0, PRESS_MS - (performance.now() - downAt));
      downAt = 0;
      timer = setTimeout(() => el.classList.remove('pressed'), left);
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
