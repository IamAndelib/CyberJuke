import { useEffect, useRef, useState } from 'preact/hooks';

export const CHUNK = 60;

/** Rows rendered per list key, so a remount renders as many as before (for scroll memory). */
const counts = new Map<string, number>();

/**
 * Render a long list in chunks: `count` rows now, `step` more whenever the sentinel
 * (placed after the rows) comes within ~a screen of the viewport.
 */
export function useChunks(total: number, key: string, step = CHUNK) {
  const [count, setCount] = useState(() => counts.get(key) ?? step);
  const sentinel = useRef<HTMLDivElement>(null);
  const keyRef = useRef(key);
  if (keyRef.current !== key) {
    keyRef.current = key;
    const c = counts.get(key) ?? step;
    if (c !== count) setCount(c);
  }
  const shown = Math.min(total, count);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || shown >= total) return;
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        setCount((c) => {
          const n = Math.min(total, c + step);
          counts.set(key, n);
          return n;
        });
      },
      { rootMargin: '800px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, total, key, step]);

  return { shown, sentinel, more: shown < total };
}
