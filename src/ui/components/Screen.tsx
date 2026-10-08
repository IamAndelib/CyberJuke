import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { TEST_HOOKS } from '../../core/testHooks';
import { scrollAnimating } from '../clickGuard';
import { Icon } from '../icons';
import { reducedMotion } from '../motion';
import { PULL_MIN_SPIN_MS, PULL_REFRESH_AT, PULL_REST, PULL_SPRING_MS, pullIntent, rubberBand } from '../pullToRefresh';
import { scrollToTop } from '../scrollToTop';
import { usePress } from '../usePress';
import { FastScroller } from './FastScroller';

/** Back-to-top shows past this many screen-heights. */
export const TOTOP_SCREENS = 1.5;
/** How long a restore keeps waiting for the content to grow tall enough. */
export const RESTORE_WAIT_MS = 1000;
/** A finger that moves this far on back-to-top is scrolling, not tapping it. */
export const TOTOP_MOVE_PX = 10;

/** scrollTop per scrollKey, for the whole app session. */
const positions = new Map<string, number>();

export function savedScroll(key: string): number | undefined {
  return positions.get(key);
}

const PTR_LABEL = { pull: '[ pull to refresh ]', release: '[ release to refresh ]', busy: '[ refreshing… ]' } as const;

/**
 * Scrollable screen with a sticky top bar, optional pull-to-refresh, scroll memory
 * (`scrollKey`) and a back-to-top button.
 *
 * Scroll memory: the position is saved per key while scrolling and restored when a
 * screen with that key mounts (or the key changes), as soon as the content is tall
 * enough, waiting up to RESTORE_WAIT_MS for it to grow. Touching the screen cancels a
 * pending restore.
 *
 * Pull-to-refresh runs outside Preact: the pull distance lives in a ref and is written
 * as a transform on the indicator and the content once per frame, so a drag re-renders
 * nothing. The content follows on a rubber band, springs back on release (or rests
 * while refreshing, for at least PULL_MIN_SPIN_MS), and a sideways swipe is left alone.
 * Touch listeners are passive, so they never hold up the start of a scroll.
 *
 * Back-to-top: a finger down on it only stops a fling; the jump starts when the finger
 * lifts without having moved TOTOP_MOVE_PX (so a scroll that starts on the button
 * doesn't jump). Android WebViews often drop that tap's click, so the jump doesn't wait
 * for it, and the click that follows is ignored; keyboard Enter/Space still go through
 * click. The jump is a frame-by-frame animation (`scrollToTop`) that a new touch on the
 * list cancels, and that touch's tap is swallowed (clickGuard).
 */
export function Screen({
  title,
  subtitle,
  left,
  right,
  bar,
  onRefresh,
  children,
  testid,
  scrollKey,
  backToTop = true,
  class: cls,
  role,
  label,
  azScroller = false,
}: {
  title?: ComponentChildren;
  subtitle?: ComponentChildren;
  left?: ComponentChildren;
  right?: ComponentChildren;
  /** Replaces the standard top bar (Search). */
  bar?: ComponentChildren;
  onRefresh?: () => Promise<void>;
  children: ComponentChildren;
  testid?: string;
  scrollKey?: string;
  backToTop?: boolean;
  class?: string;
  role?: 'dialog' | 'region';
  label?: string;
  /** A–Z sections (`.az-head`): show the section letter while scrolling. */
  azScroller?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const ptr = useRef<HTMLDivElement>(null);
  const ptrLabel = useRef<HTMLSpanElement>(null);
  const topBtn = useRef<HTMLButtonElement>(null);
  const [showTop, setShowTop] = useState(false);
  const keyRef = useRef(scrollKey);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  /** Target of a restore still waiting for content; saving is paused meanwhile. */
  const pending = useRef<(() => void) | null>(null);
  const frame = useRef(0);
  /** Cancels a running back-to-top animation. */
  const stopTop = useRef<(() => void) | null>(null);
  /** Back-to-top was pressed by a pointer: that press's own click is then ignored. */
  const topArmed = useRef(false);
  /** The finger on back-to-top, until it lifts or moves away. */
  const topTap = useRef<{ id: number; x: number; y: number } | null>(null);
  usePress(topBtn);

  const updateTop = () => {
    frame.current = 0;
    const el = scroller.current;
    if (!el) return;
    setShowTop(backToTop && el.scrollTop > el.clientHeight * TOTOP_SCREENS);
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    if (!pending.current && keyRef.current) positions.set(keyRef.current, el.scrollTop);
    if (!frame.current) frame.current = requestAnimationFrame(updateTop);
  };

  const cancelRestore = () => pending.current?.();
  const cancelTop = () => {
    stopTop.current?.();
    stopTop.current = null;
  };
  /** A new touch or wheel on the list (not on back-to-top itself): stop a running back-to-top. */
  const interruptTop = (e: Event) => {
    if (!(e.target as Element | null)?.closest?.('.totop-btn')) cancelTop();
  };

  useLayoutEffect(() => {
    keyRef.current = scrollKey;
    const el = scroller.current;
    if (!el || !scrollKey) return;
    const target = positions.get(scrollKey);
    if (target == null) return;
    const apply = () => {
      el.scrollTop = target;
      return Math.abs(el.scrollTop - target) <= 1;
    };
    if (apply()) {
      updateTop();
      return;
    }
    let ro: ResizeObserver | null = null;
    const done = () => {
      if (pending.current !== done) return;
      pending.current = null;
      ro?.disconnect();
      clearTimeout(timer);
      if (keyRef.current) positions.set(keyRef.current, el.scrollTop);
      updateTop();
    };
    pending.current = done;
    const timer = setTimeout(done, RESTORE_WAIT_MS);
    if (typeof ResizeObserver === 'function' && body.current) {
      ro = new ResizeObserver(() => {
        if (pending.current === done && apply()) done();
      });
      ro.observe(body.current);
    }
    return done;
    // Runs per scroll key; `updateTop` reads only refs and the `backToTop` prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey]);

  // Touch and wheel, as passive native listeners: pull-to-refresh, and stopping a
  // restore or a back-to-top in progress.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const pull = {
      start: null as { x: number; y: number } | null,
      pulling: false,
      busy: false,
      d: 0,
      frame: 0,
      label: '' as '' | keyof typeof PTR_LABEL,
      timer: 0 as ReturnType<typeof setTimeout> | 0,
    };
    const setLabel = (l: keyof typeof PTR_LABEL) => {
      if (pull.label === l) return;
      pull.label = l;
      if (ptrLabel.current) ptrLabel.current.textContent = PTR_LABEL[l];
      ptr.current?.classList.toggle('busy', l === 'busy');
    };
    /** Write the offset now; with `spring`, ease there over PULL_SPRING_MS (instant with reduced motion). */
    const paint = (spring: boolean) => {
      pull.frame = 0;
      const b = body.current;
      const p = ptr.current;
      if (!b || !p) return;
      const t = spring && !reducedMotion() ? `transform ${PULL_SPRING_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity ${PULL_SPRING_MS}ms` : 'none';
      b.style.transition = p.style.transition = t;
      b.style.transform = pull.d ? `translateY(${pull.d}px)` : '';
      p.style.transform = `translateY(${pull.d}px)`;
      p.style.opacity = String(Math.min(1, pull.d / PULL_REFRESH_AT));
    };
    const schedule = () => {
      if (!pull.frame) pull.frame = requestAnimationFrame(() => paint(false));
    };
    /** Spring to `d` (0 = put away); `then` runs when it has got there. */
    const springTo = (d: number, then?: () => void) => {
      cancelAnimationFrame(pull.frame);
      pull.d = d;
      paint(true);
      clearTimeout(pull.timer);
      pull.timer = setTimeout(() => {
        if (!pull.d && body.current) {
          // At rest: no transform left on the content (no stacking context, sticky as usual).
          body.current.style.transform = body.current.style.transition = '';
          body.current.style.willChange = '';
        }
        then?.();
      }, reducedMotion() ? 0 : PULL_SPRING_MS);
    };
    const release = async () => {
      const go = pull.d >= PULL_REFRESH_AT && !!refresh.current;
      if (!go) return springTo(0);
      pull.busy = true;
      setLabel('busy');
      ptr.current?.setAttribute('aria-busy', 'true');
      springTo(PULL_REST);
      const t0 = performance.now();
      try {
        await refresh.current!();
      } catch {
        // The screen shows its own error state; the gesture just ends.
      }
      const left = PULL_MIN_SPIN_MS - (performance.now() - t0);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
      ptr.current?.removeAttribute('aria-busy');
      springTo(0, () => {
        pull.busy = false;
        setLabel('pull');
      });
    };

    const onStart = (e: TouchEvent) => {
      cancelRestore();
      interruptTop(e);
      pull.start = null;
      if (!refresh.current || pull.busy || e.touches.length !== 1 || el.scrollTop > 0) return;
      pull.start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      pull.pulling = false;
    };
    const onMove = (e: TouchEvent) => {
      const s = pull.start;
      if (!s) return;
      const p = e.touches[0];
      const dx = p.clientX - s.x;
      const dy = p.clientY - s.y;
      if (!pull.pulling) {
        const intent = pullIntent(dx, dy);
        if (intent === 'wait') return;
        if (intent === 'other') return void (pull.start = null);
        pull.pulling = true;
        setLabel('pull');
        if (body.current) body.current.style.willChange = 'transform';
      }
      if (el.scrollTop > 2 || dy <= 0) {
        // The list scrolled after all (a pixel or two is overscroll noise): give the gesture back.
        pull.start = null;
        pull.pulling = false;
        return springTo(0);
      }
      pull.d = rubberBand(dy);
      setLabel(pull.d >= PULL_REFRESH_AT ? 'release' : 'pull');
      schedule();
    };
    const onEnd = () => {
      const was = pull.pulling;
      pull.start = null;
      pull.pulling = false;
      if (was) void release();
    };
    const onWheel = (e: WheelEvent) => {
      cancelRestore();
      interruptTop(e);
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('wheel', onWheel);
      cancelAnimationFrame(pull.frame);
      clearTimeout(pull.timer);
    };
    // Mount-only: everything it uses is a ref (`onRefresh` goes through `refresh`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      stopTop.current?.();
    },
    [],
  );

  const toTop = () => {
    cancelRestore();
    cancelTop();
    const el = scroller.current;
    if (!el) return;
    const done = scrollAnimating(el);
    const stop = scrollToTop(el, {
      reduced: reducedMotion(),
      onDone: () => {
        stopTop.current = null;
        done();
      },
    });
    stopTop.current = () => {
      stop();
      done();
    };
  };
  const onTopDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // No focus move or compatibility mouse events.
    e.preventDefault();
    topArmed.current = true;
    topTap.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    // Finger down only stops what is moving: a back-to-top already running, or a fling
    // (any write to scrollTop ends the momentum).
    cancelTop();
    const el = scroller.current;
    el?.scrollTo({ top: el.scrollTop, behavior: 'instant' });
  };
  const moved = (e: PointerEvent) => {
    const t = topTap.current;
    return !t || t.id !== e.pointerId || Math.hypot(e.clientX - t.x, e.clientY - t.y) >= TOTOP_MOVE_PX;
  };
  const onTopMove = (e: PointerEvent) => {
    if (topTap.current && moved(e)) topTap.current = null;
  };
  const onTopUp = (e: PointerEvent) => {
    const tap = !moved(e);
    topTap.current = null;
    if (tap) toTop();
  };
  const onTopClick = (e: MouseEvent) => {
    const tapClick = topArmed.current && e.detail > 0;
    topArmed.current = false;
    // A keyboard click (Enter/Space, detail 0) or one with no pointerdown before it.
    if (!tapClick) toTop();
  };

  return (
    <div
      class={'screen' + (backToTop ? ' has-totop' : '') + (cls ? ' ' + cls : '')}
      ref={scroller}
      data-testid={testid}
      role={role}
      aria-label={label}
      onScroll={onScroll}
      onPointerDown={interruptTop}
      onKeyDown={cancelRestore}
    >
      <FastScroller scroller={scroller} az={azScroller} onDragStart={cancelRestore} />
      {bar ?? (
        <header class="topbar">
          {left && <div class="topbar-left">{left}</div>}
          <div class="topbar-titles">
            <h1 class="topbar-title">{title}</h1>
            {subtitle && <div class="topbar-sub">{subtitle}</div>}
          </div>
          {right && <div class="topbar-right">{right}</div>}
        </header>
      )}
      {onRefresh && (
        <div class="ptr-dock">
          <div class="ptr" ref={ptr} aria-live="polite" data-testid="ptr">
            <span class="spinner" aria-hidden="true" />
            <span class="ptr-label" ref={ptrLabel} />
          </div>
        </div>
      )}
      <div class="screen-body" ref={body}>
        {children}
      </div>
      {backToTop && (
        <div class="totop-dock">
          <div class={'totop' + (showTop ? ' on' : '')}>
            <button
              ref={topBtn}
              class="totop-btn"
              aria-label="Back to top"
              onPointerDown={onTopDown}
              onPointerMove={onTopMove}
              onPointerUp={onTopUp}
              onPointerCancel={() => (topTap.current = null)}
              onClick={onTopClick}
              tabIndex={showTop ? 0 : -1}
              aria-hidden={showTop ? undefined : true}
              data-testid="back-to-top"
            >
              <Icon name="up" size={24} />
            </button>
            <div class="totop-shadow" aria-hidden="true" />
          </div>
        </div>
      )}
    </div>
  );
}

// Named for the dev/test render counter (minified builds lose function names).
if (TEST_HOOKS) (Screen as { displayName?: string }).displayName = 'Screen';
