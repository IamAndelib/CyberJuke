import { useEffect, useRef } from 'preact/hooks';
import { reducedMotion } from '../core/motion';
import { scrollAnimating } from './clickGuard';
import { scrollToTop } from './scrollToTop';

/** A finger that moves this far on the button is scrolling, not tapping it. */
const TAP_MOVE_PX = 10;

/**
 * A button that scrolls a list (back-to-top, Now Playing's back to the song playing) the way every
 * such button should: a finger down on it only stops a fling, and the jump starts when the finger
 * lifts without having moved TAP_MOVE_PX (so a scroll that starts on the button doesn't jump).
 * Android WebViews often drop that tap's click, so the jump doesn't wait for it, and the click that
 * follows is ignored; keyboard Enter/Space still go through click. The jump is `scrollToTop`'s
 * animation (to `to()`, the top by default), registered with the click guard (M6), and a new touch,
 * pointer or wheel on the list stops it. Give the button class `totop-btn`: a touch on it isn't one
 * on the list. `go` runs the jump (`before` first), `props` go on the button.
 */
export function useJumpButton(scroller: () => HTMLElement | null, opts: { to?: () => number; before?: () => void } = {}) {
  const stop = useRef<(() => void) | null>(null);
  /** The button was pressed by a pointer: that press's own click is then ignored. */
  const armed = useRef(false);
  /** The finger on the button, until it lifts or moves away. */
  const tap = useRef<{ id: number; x: number; y: number } | null>(null);
  const latest = useRef({ scroller, opts });
  latest.current = { scroller, opts };

  const cancel = () => {
    stop.current?.();
    stop.current = null;
  };
  const go = () => {
    const { scroller, opts } = latest.current;
    opts.before?.();
    cancel();
    const el = scroller();
    if (!el) return;
    const done = scrollAnimating(el);
    const end = scrollToTop(el, {
      to: opts.to?.(),
      reduced: reducedMotion(),
      onDone: () => {
        stop.current = null;
        done();
      },
    });
    stop.current = () => {
      end();
      done();
    };
  };

  // A new touch, pointer or wheel on the list (not on the button itself) stops a jump in progress.
  useEffect(() => {
    const el = latest.current.scroller();
    if (!el) return;
    const interrupt = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.('.totop-btn')) cancel();
    };
    const events = ['pointerdown', 'touchstart', 'wheel'];
    for (const t of events) el.addEventListener(t, interrupt, { passive: true });
    return () => {
      for (const t of events) el.removeEventListener(t, interrupt);
      cancel();
    };
  }, []);

  const moved = (e: PointerEvent) => {
    const t = tap.current;
    return !t || t.id !== e.pointerId || Math.hypot(e.clientX - t.x, e.clientY - t.y) >= TAP_MOVE_PX;
  };
  const props = {
    onPointerDown(e: PointerEvent) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // No focus move or compatibility mouse events.
      e.preventDefault();
      armed.current = true;
      tap.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
      // Finger down only stops what is moving: a jump already running, or a fling
      // (any write to scrollTop ends the momentum).
      cancel();
      const el = latest.current.scroller();
      el?.scrollTo({ top: el.scrollTop, behavior: 'instant' });
    },
    onPointerMove(e: PointerEvent) {
      if (tap.current && moved(e)) tap.current = null;
    },
    onPointerUp(e: PointerEvent) {
      const isTap = !moved(e);
      tap.current = null;
      if (isTap) go();
    },
    onPointerCancel() {
      tap.current = null;
    },
    onClick(e: MouseEvent) {
      const tapClick = armed.current && e.detail > 0;
      armed.current = false;
      // A keyboard click (Enter/Space, detail 0) or one with no pointerdown before it.
      if (!tapClick) go();
    },
  };
  return { go, props };
}
