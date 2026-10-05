import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';

const THRESHOLD = 64;

/**
 * Scrollable screen with a sticky top bar and optional pull-to-refresh.
 */
export function Screen({
  title,
  subtitle,
  left,
  right,
  onRefresh,
  children,
  testid,
}: {
  title: ComponentChildren;
  subtitle?: ComponentChildren;
  left?: ComponentChildren;
  right?: ComponentChildren;
  onRefresh?: () => Promise<void>;
  children: ComponentChildren;
  testid?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const onTouchStart = (e: TouchEvent) => {
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

  const shown = refreshing ? THRESHOLD * 0.75 : pull;
  return (
    <div
      class="screen"
      ref={scroller}
      data-testid={testid}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <header class="topbar">
        {left && <div class="topbar-left">{left}</div>}
        <div class="topbar-titles">
          <h1 class="topbar-title">{title}</h1>
          {subtitle && <div class="topbar-sub">{subtitle}</div>}
        </div>
        {right && <div class="topbar-right">{right}</div>}
      </header>
      {onRefresh && (
        <div class="ptr" style={{ height: `${shown}px` }} aria-live="polite" data-testid="ptr">
          {(shown > 8 || refreshing) && (
            <span>{refreshing ? '[ refreshing… ]' : pull >= THRESHOLD ? '[ release to refresh ]' : '[ pull to refresh ]'}</span>
          )}
        </div>
      )}
      <div class="screen-body">{children}</div>
    </div>
  );
}
