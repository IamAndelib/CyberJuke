import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../icons';
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
  }, [scrollKey]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onTouchStart = (e: TouchEvent) => {
    cancelRestore();
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
    scroller.current?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
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
      onWheel={cancelRestore}
      onKeyDown={cancelRestore}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <FastScroller scroller={scroller} az={azScroller} />
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
              onClick={toTop}
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
