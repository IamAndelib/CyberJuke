import { useEffect, useRef, useState } from 'preact/hooks';
import { holdInert, isHeldInert, releaseInert } from './inert';

/** What sits behind a sheet: the app and, when it is up, Now Playing. */
const BEHIND = '.app, .np';

/**
 * A sheet that is modal for real while [open]:
 * - what's behind it is inert (no taps, no focus, no scrolling it from under the sheet);
 * - focus moves to its first control, and back to whatever had it when it closes (or, if
 *   that has gone, to the first control on its page), as soon as that is no longer inert
 *   (the app behind Now Playing stops being inert a moment after the sheet starts closing);
 * - it only takes pan gestures itself when its content is taller than it (`scrolls`), so
 *   a drag on a short sheet can't hand the scroll to the page behind (Android WebView).
 */
export function useModal(open: boolean, sheet: { current: HTMLElement | null }, opts: { inertBehind?: boolean } = {}): void {
  const inertBehind = opts.inertBehind ?? true;
  useEffect(() => {
    if (!open) return;
    const el = sheet.current;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Its page, in case the sheet's action removes it (Library → Clear history).
    const page = before?.closest<HTMLElement>('.screen') ?? null;
    // What's behind is held inert by this sheet too (not what markup makes inert): it is
    // given back only once nothing else holds it (Now Playing under a menu).
    const made = inertBehind
      ? [...document.querySelectorAll<HTMLElement>(BEHIND)].filter((b) => (!b.inert || isHeldInert(b)) && !b.contains(el))
      : [];
    const owner = {};
    for (const b of made) holdInert(b, owner);
    const frame = requestAnimationFrame(() => {
      if (!el) return;
      if (el.classList.contains('sheet')) el.classList.toggle('scrolls', el.scrollHeight > el.clientHeight + 1);
      el.querySelector<HTMLElement>('button:not([disabled]), [href]')?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      for (const b of made) releaseInert(b, owner);
      giveFocusBack(el, before, page);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sheet` is a stable ref; only opening and closing matter.
  }, [open]);
}

/** Frames to wait for the control to stop being inert before giving up. */
const FOCUS_BACK_FRAMES = 20;

/**
 * Focus goes back to `before` (or the first control of its page, if it has gone) once that
 * isn't inert, unless the user has put focus somewhere else meanwhile.
 */
function giveFocusBack(sheet: HTMLElement | null, before: HTMLElement | null, page: HTMLElement | null, frames = FOCUS_BACK_FRAMES): void {
  const target = before?.isConnected ? before : page?.isConnected ? page.querySelector<HTMLElement>('button:not([disabled]), [href]') : null;
  if (!target) return;
  const now = document.activeElement;
  if (now && now !== document.body && !sheet?.contains(now)) return;
  if (!target.closest('[inert]')) {
    target.focus({ preventScroll: true });
    return;
  }
  if (frames > 0) requestAnimationFrame(() => giveFocusBack(sheet, before, page, frames - 1));
}

/** Longest a closing sheet keeps its content if no transitionend comes (hidden page, no transition). */
const SHEET_CLEAR_MS = 400;

/**
 * What a bottom sheet shows: `value` while open, and the last one while it slides away,
 * until the sheet's transform transition ends. So it never collapses to an empty strip
 * on the way out.
 */
export function useSheetContent<T>(value: T | null, sheet: { current: HTMLElement | null }): T | null {
  const last = useRef(value);
  const [, force] = useState(0);
  if (value != null) last.current = value;
  useEffect(() => {
    const el = sheet.current;
    if (value != null || last.current == null || !el) return;
    const clear = () => {
      if (last.current == null) return;
      last.current = null;
      force((n) => n + 1);
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === el && e.propertyName === 'transform') clear();
    };
    el.addEventListener('transitionend', onEnd);
    const timer = setTimeout(clear, SHEET_CLEAR_MS);
    return () => {
      el.removeEventListener('transitionend', onEnd);
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sheet` is a stable ref; only opening and closing matter.
  }, [value]);
  return value ?? last.current;
}
