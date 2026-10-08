/**
 * Dev/test only: counts Preact component renders by component name, through the
 * `options` render hook, as `window.__cyberjukeRenders`. The e2e perf spec reads it
 * to check that playback doesn't re-render the screen.
 */
import { options } from 'preact';
import { TEST_HOOKS, exposeForTests } from './testHooks';

type RenderHook = (vnode: { type: unknown }) => void;

/**
 * Install the counter. Builds minify function names, so the components the perf spec
 * asserts on are named here (`displayName`).
 */
export function installRenderCounter(named: Record<string, unknown> = {}): void {
  if (!TEST_HOOKS) return;
  for (const [name, c] of Object.entries(named)) if (typeof c === 'function') (c as { displayName?: string }).displayName = name;
  const counts: Record<string, number> = {};
  const o = options as unknown as { __r?: RenderHook };
  const prev = o.__r;
  o.__r = (vnode) => {
    const t = vnode.type as { displayName?: string; name?: string } | string;
    if (typeof t === 'function') {
      const name = (t as { displayName?: string }).displayName || (t as { name?: string }).name || 'anonymous';
      counts[name] = (counts[name] ?? 0) + 1;
    }
    prev?.(vnode);
  };
  exposeForTests('__cyberjukeRenders', {
    counts,
    reset() {
      for (const k of Object.keys(counts)) delete counts[k];
    },
  });
}
