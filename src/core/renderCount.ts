/**
 * Dev/test only: counts Preact component renders by component name, through the
 * `options` render hook, as `window.__cyberjukeRenders`. The e2e perf spec reads it
 * to check that playback doesn't re-render the screen.
 */
import { options } from 'preact';
import { TEST_HOOKS, exposeForTests } from './testHooks';

type RenderHook = (vnode: { type: unknown }) => void;

export function installRenderCounter(): void {
  if (!TEST_HOOKS) return;
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
