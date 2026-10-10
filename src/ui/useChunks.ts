import { useEffect, useRef, useState } from 'preact/hooks';
import { whenIdle } from '../core/idle';

const CHUNK = 60;

/** Rows rendered per list key, so a remount renders as many as before (for scroll memory). */
const counts = new Map<string, number>();
const MAX_KEYS = 100;

function remember(key: string | null, n: number): void {
  if (key == null) return;
  counts.delete(key);
  counts.set(key, n);
  if (counts.size > MAX_KEYS) counts.delete(counts.keys().next().value!);
}

interface ChunkOptions {
  /**
   * Keep adding chunks in idle time until everything is rendered (grids with an A–Z
   * scroller need their full height); otherwise more come only near the bottom.
   */
  fill?: boolean;
}

/**
 * Render a long list in chunks: `step` rows first, then `step` more whenever the
 * sentinel (placed after the rows) comes within ~a screen of the viewport, or in idle
 * time with `fill`. `key` remembers how many were shown (null: don't remember).
 */
export function useChunks(total: number, key: string | null, step = CHUNK, opts: ChunkOptions = {}) {
  const initial = () => (key != null ? counts.get(key) : undefined) ?? step;
  const [count, setCount] = useState(initial);
  const sentinel = useRef<HTMLDivElement>(null);
  const keyRef = useRef(key);
  if (keyRef.current !== key) {
    keyRef.current = key;
    const c = initial();
    if (c !== count) setCount(c);
  }
  const shown = Math.min(total, count);
  const grow = () =>
    setCount((c) => {
      const n = Math.min(total, c + step);
      remember(key, n);
      return n;
    });

  useEffect(() => {
    if (shown >= total) return;
    if (opts.fill) return whenIdle(grow, 200, 16);
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && grow(), { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `grow` reads only total/step/key, all listed.
  }, [shown, total, key, step, opts.fill]);

  return { shown, sentinel, more: shown < total };
}

/** The first `n` items of A–Z sections (for rendering grouped lists in chunks). */
export function takeSections<T>(sections: readonly { letter: string; items: T[] }[], n: number): { letter: string; items: T[] }[] {
  const out: { letter: string; items: T[] }[] = [];
  let left = n;
  for (const s of sections) {
    if (left <= 0) break;
    out.push(s.items.length <= left ? s : { letter: s.letter, items: s.items.slice(0, left) });
    left -= s.items.length;
  }
  return out;
}
