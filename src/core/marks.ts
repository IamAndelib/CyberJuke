/**
 * Dev/test only: startup timings as performance marks, each set once (the first time it
 * happens), read as `window.__cyberjukeMarks()` (ms since navigation, by name). The e2e
 * and @live specs use them to check the startup order and to measure it. In a
 * production build TEST_HOOKS is false and nothing is marked.
 */
import { TEST_HOOKS, exposeForTests } from './testHooks';

/**
 * boot: the app's code starts. storage: what the first screen needs is read. request: the
 * first Firestore query is sent. response: its answer is read. render: the first render
 * is done. first-row: a list's first rows are on screen.
 */
type StartupMark = 'boot' | 'storage' | 'request' | 'response' | 'render' | 'first-row';

const PREFIX = 'cyberjuke:';

export function mark(name: StartupMark): void {
  if (!TEST_HOOKS || typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
  if (performance.getEntriesByName(PREFIX + name, 'mark').length) return;
  performance.mark(PREFIX + name);
}

exposeForTests('__cyberjukeMarks', () =>
  Object.fromEntries(
    performance
      .getEntriesByType('mark')
      .filter((m) => m.name.startsWith(PREFIX))
      .map((m) => [m.name.slice(PREFIX.length), Math.round(m.startTime)]),
  ),
);
