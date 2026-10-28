/**
 * Screens coming and going with the browser's own View Transitions (Chromium 111+): the
 * old screen is snapshotted, `update` changes the DOM, and CSS animates between the two
 * (app/shell.css, by `kind` on <html data-vt>). Where the WebView has no
 * startViewTransition, with reduced motion, or while the page is hidden, `update` runs at
 * once, as it always did.
 *
 * The update runs a frame later, once the old screen is captured. A navigation that comes
 * meanwhile first runs the waiting one (settleTransition), so it decides on the screen as
 * it is now.
 */
import { reducedMotion } from '../core/motion';

/** back: the screen goes the way it came (Back, Settings closing). forward: Settings comes in. tab: a fade. */
export type TransitionKind = 'back' | 'forward' | 'tab';

let pending: (() => void) | null = null;
let active: ViewTransition | null = null;

/** Runs the navigation waiting for its transition now, if any. */
export function settleTransition(): void {
  const run = pending;
  pending = null;
  run?.();
}

export function withTransition(kind: TransitionKind, update: () => void): void {
  settleTransition();
  if (typeof document === 'undefined' || !document.startViewTransition || reducedMotion() || document.visibilityState === 'hidden') {
    update();
    return;
  }
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    if (pending === run) pending = null;
    update();
  };
  pending = run;
  const root = document.documentElement;
  root.dataset.vt = kind;
  const t = document.startViewTransition(async () => {
    run();
    // Preact renders the signals' change in a microtask: a task later, the DOM is the new screen.
    await new Promise((r) => setTimeout(r, 0));
  });
  active = t;
  // Finished or skipped: its kind goes, unless a newer transition has set its own.
  void t.finished.finally(() => {
    if (active !== t) return;
    active = null;
    delete root.dataset.vt;
  });
}
