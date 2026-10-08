import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../icons';
import { scrollToTop } from '../scrollToTop';
import { FastScroller } from './FastScroller';

const THRESHOLD = 64;
/** Back-to-top shows past this many screen-heights. */
export const TOTOP_SCREENS = 1.5;
/** How long a restore keeps waiting for the content to grow tall enough. */
export const RESTORE_WAIT_MS = 1000;

/** scrollTop per scrollKey, for the whole app session. */
const positions = new Map<string, number>();

export function savedScroll(key: string): number | undefined {
  return positions.get(key);
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Scrollable screen with a sticky top bar, optional pull-to-refresh, scroll memory
 * (`scrollKey`) and a back-to-top button.
 *
 * Scroll memory: the position is saved per key while scrolling and restored when a
 * screen with that key mounts (or the key changes), as soon as the content is tall
 * enough, waiting up to RESTORE_WAIT_MS for it to grow. Touching the screen cancels a
 * pending restore.
 *
 * Back-to-top acts on pointerdown, so the tap that stops a fling also starts the jump
 * (Android WebViews often drop that tap's click), and the click that follows is
 * ignored; keyboard Enter/Space still go through click. The jump is a frame-by-frame
 * animation (`scrollToTop`) that a new touch on the list cancels.
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
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [showTop, setShowTop] = useState(false);
  const keyRef = useRef(scrollKey);
  /** Target of a restore still waiting for content; saving is paused meanwhile. */
  const pending = useRef<(() => void) | null>(null);
  const frame = useRef(0);
  /** Cancels a running back-to-top animation. */
  const stopTop = useRef<(() => void) | null>(null);
  /** Back-to-top fired on pointerdown: that tap's own click is then ignored. */
  const topArmed = useRef(false);

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

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      stopTop.current?.();
    },
    [],
  );

  const onTouchStart = (e: TouchEvent) => {
    cancelRestore();
    interruptTop(e);
    if (!onRefresh || refreshing) return;
    startY.current = (scroller.current?.scrollTop ?? 0) <= 0 ? e.touches[0].clientY : null;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (startY.current == null) return;
    const dy = e.touches[0].clientY - startY.current;
    if (dy <= 0 || (scroller.current?.scrollTop ?? 0) > 0) {
      if (pull) setPull(0);
      return;
    }
    setPull(Math.min(110, dy * 0.5));
  };
  const onTouchEnd = async () => {
    if (startY.current == null) return;
    startY.current = null;
    const go = pull >= THRESHOLD;
    setPull(0);
    if (go && onRefresh) {
      setRefreshing(true);
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
      }
    }
  };

  const toTop = () => {
    cancelRestore();
    cancelTop();
    const el = scroller.current;
    if (!el) return;
    stopTop.current = scrollToTop(el, {
      reduced: reducedMotion(),
      onDone: () => (stopTop.current = null),
    });
  };
  const onTopDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // No focus move or compatibility mouse events; the jump starts now.
    e.preventDefault();
    topArmed.current = true;
    toTop();
  };
  const onTopClick = (e: MouseEvent) => {
    const tapClick = topArmed.current && e.detail > 0;
    topArmed.current = false;
    // A keyboard click (Enter/Space, detail 0) or one with no pointerdown before it.
    if (!tapClick) toTop();
  };

  const shown = refreshing ? THRESHOLD * 0.75 : pull;
  return (
    <div
      class={'screen' + (backToTop ? ' has-totop' : '') + (cls ? ' ' + cls : '')}
      ref={scroller}
      data-testid={testid}
      role={role}
      aria-label={label}
      onScroll={onScroll}
      onPointerDown={interruptTop}
      onWheel={(e) => {
        cancelRestore();
        interruptTop(e);
      }}
      onKeyDown={cancelRestore}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
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
        <div class="ptr" style={{ height: `${shown}px` }} aria-live="polite" data-testid="ptr">
          {(shown > 8 || refreshing) && (
            <span>{refreshing ? '[ refreshing… ]' : pull >= THRESHOLD ? '[ release to refresh ]' : '[ pull to refresh ]'}</span>
          )}
        </div>
      )}
      <div class="screen-body" ref={body}>
        {children}
      </div>
      {backToTop && (
        <div class="totop-dock">
          <div class={'totop' + (showTop ? ' on' : '')}>
            <button
              class="totop-btn"
              aria-label="Back to top"
              onPointerDown={onTopDown}
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
