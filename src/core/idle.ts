type RequestIdle = (cb: () => void, o?: { timeout: number }) => number;

/**
 * Run `cb` once the page is idle (at the latest after `timeoutMs`), or after `fallbackMs`
 * where there is no requestIdleCallback (older WebViews). Returns a cancel function.
 */
export function whenIdle(cb: () => void, timeoutMs: number, fallbackMs: number): () => void {
  const g = globalThis as { requestIdleCallback?: RequestIdle; cancelIdleCallback?: (id: number) => void };
  if (g.requestIdleCallback) {
    const id = g.requestIdleCallback(cb, { timeout: timeoutMs });
    return () => g.cancelIdleCallback?.(id);
  }
  const t = setTimeout(cb, fallbackMs);
  return () => clearTimeout(t);
}
