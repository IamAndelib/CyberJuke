/**
 * Back-to-top as a frame-by-frame animation (and, with `to`, any other jump of a list). Writing `scrollTop` on every frame (rather
 * than the browser's smooth `scrollTo`) also overrides whatever fling momentum is left,
 * so the jump starts from the same tap that stops a fling. Pure TS: the clock and frame
 * scheduler are injectable for tests.
 */

export const TO_TOP_MS = 300;

/** Ease-out cubic: fast start, gentle landing. */
export function easeOut(t: number): number {
  const p = Math.min(1, Math.max(0, t));
  return 1 - (1 - p) ** 3;
}

interface ScrollToTopOptions {
  /** The scrollTop to scroll to (default 0, the top). */
  to?: number;
  /** Jump at once, no animation (prefers-reduced-motion). */
  reduced?: boolean;
  duration?: number;
  now?: () => number;
  raf?: (cb: FrameRequestCallback) => number;
  caf?: (id: number) => void;
  /** Called once the target is reached (not when cancelled). */
  onDone?: () => void;
}

/**
 * Scroll `el` to the top (or `to`): instantly with `reduced`, else over `duration` ms with
 * ease-out, writing `scrollTop` every frame. Returns a cancel function (call it when
 * the user touches the list again); cancelling leaves the list where it is.
 */
export function scrollToTop(el: { scrollTop: number }, opts: ScrollToTopOptions = {}): () => void {
  const now = opts.now ?? (() => performance.now());
  const raf = opts.raf ?? ((cb) => requestAnimationFrame(cb));
  const caf = opts.caf ?? ((id) => cancelAnimationFrame(id));
  const duration = opts.duration ?? TO_TOP_MS;
  const to = opts.to ?? 0;
  const from = el.scrollTop;
  if (opts.reduced || duration <= 0 || from === to || (to === 0 && from < 0)) {
    el.scrollTop = to;
    opts.onDone?.();
    return () => {};
  }
  const start = now();
  let id = 0;
  let live = true;
  const step = () => {
    if (!live) return;
    const t = (now() - start) / duration;
    if (t >= 1) {
      el.scrollTop = to;
      live = false;
      opts.onDone?.();
      return;
    }
    el.scrollTop = Math.round(to + (from - to) * (1 - easeOut(t)));
    id = raf(step);
  };
  // The first write happens now: it stops any momentum before the next frame.
  step();
  return () => {
    if (!live) return;
    live = false;
    caf(id);
  };
}
