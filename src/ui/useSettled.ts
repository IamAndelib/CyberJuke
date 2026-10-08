import type { RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { usePageActive } from './nav';

/**
 * M8: a value shown above a grid (the Favourites section) that must not move the grid
 * under the finger that just changed it. A new value is taken while the page isn't
 * showing (so the next visit has it) or once the user has scrolled, never in between.
 * Put the returned ref on an element inside the page's scroller.
 */
export function useSettled<T>(value: T): [T, RefObject<HTMLDivElement | null>] {
  const [shown, setShown] = useState(value);
  const active = usePageActive();
  const anchor = useRef<HTMLDivElement>(null);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    if (!active) setShown(value);
  }, [active, value]);

  useEffect(() => {
    if (!active || shown === value) return;
    const scroller = anchor.current?.closest<HTMLElement>('.screen');
    if (!scroller) return;
    const event = 'onscrollend' in window ? 'scrollend' : 'scroll';
    const take = () => setShown(latest.current);
    scroller.addEventListener(event, take, { passive: true, once: true });
    return () => scroller.removeEventListener(event, take);
  }, [active, value, shown]);

  return [shown, anchor];
}
