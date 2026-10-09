/**
 * A tap that stops a scroll does nothing else (M6). While the app scrolls something by
 * animation (back-to-top, the new-tracks pill, the lyrics following the song), a finger
 * that lands inside it is taken as "stop", not "tap": the click that follows is
 * swallowed in the capture phase, so the row or lyric line under the finger isn't
 * activated. Keyboard clicks (detail 0) always go through, and so do taps on the app's
 * chrome controls (see tapThrough.ts).
 */
import { tapThroughControl } from './tapThrough';

/** Longest a smooth scroll counts as running when no `scrollend` arrives (older WebViews). */
export const SMOOTH_SCROLL_MS = 700;
/** A swallowed tap must click within this long after its finger went down. */
const TAP_MS = 1000;

const running = new Map<Element, number>();
let armedAt = 0;

/** `el` is being scrolled by the app from now until `done()` is called. */
export function scrollAnimating(el: Element): () => void {
  running.set(el, (running.get(el) ?? 0) + 1);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    const n = (running.get(el) ?? 1) - 1;
    if (n > 0) running.set(el, n);
    else running.delete(el);
  };
}

/**
 * A smooth `scrollTo` on `el` was just started: it counts as running until its
 * `scrollend` (or SMOOTH_SCROLL_MS where that never comes). Returns `done` too.
 */
export function smoothScrolling(el: Element, ms = SMOOTH_SCROLL_MS): () => void {
  const done = scrollAnimating(el);
  const end = () => {
    clearTimeout(timer);
    el.removeEventListener('scrollend', end);
    done();
  };
  const timer = setTimeout(end, ms);
  el.addEventListener('scrollend', end, { passive: true });
  return end;
}

/** Whether the click guard would swallow a tap landing on `target` now (for tests). */
function scrollRunningUnder(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false;
  for (const el of running.keys()) if (el.contains(target)) return true;
  return false;
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (e) => {
      // The app's chrome (search button, top bars, tab bar…) always takes its tap (tapThrough.ts).
      armedAt = e.isPrimary && scrollRunningUnder(e.target) && !tapThroughControl(e.target) ? e.timeStamp || performance.now() : 0;
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    'click',
    (e) => {
      if (!armedAt || e.detail === 0) return;
      const fresh = (e.timeStamp || performance.now()) - armedAt < TAP_MS;
      armedAt = 0;
      if (!fresh) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    { capture: true },
  );
}
