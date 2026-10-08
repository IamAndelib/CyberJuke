/**
 * Pull-to-refresh numbers, kept pure for tests: how far the content follows the finger
 * (a rubber band), and when a release refreshes.
 */

/** The content never moves further than this, however far the finger goes. */
export const PULL_MAX = 140;
/** Released at or past this distance (of the content, not the finger): refresh. */
export const PULL_REFRESH_AT = 56;
/** Where the content rests while refreshing. */
export const PULL_REST = 48;
/** How long the spring back (or into the resting place) takes. */
export const PULL_SPRING_MS = 180;
/** The refreshing state shows at least this long, so it never just flashes. */
export const PULL_MIN_SPIN_MS = 400;
/** A finger has to move this far before the gesture counts as a pull (or a sideways swipe). */
export const PULL_SLOP = 8;

/**
 * Content offset for a finger `dy` px down: follows at 0.6 at first, then resists more
 * and more, approaching PULL_MAX.
 */
export function rubberBand(dy: number): number {
  if (dy <= 0) return 0;
  return PULL_MAX * (1 - 1 / (1 + (dy * 0.6) / PULL_MAX));
}

/**
 * What a finger that moved (dx, dy) since touching down is doing: still undecided
 * (inside the slop), pulling down, or something else (sideways or up), which leaves the
 * gesture to the browser.
 */
export function pullIntent(dx: number, dy: number): 'wait' | 'pull' | 'other' {
  if (Math.abs(dx) < PULL_SLOP && Math.abs(dy) < PULL_SLOP) return 'wait';
  return dy > 0 && dy >= Math.abs(dx) ? 'pull' : 'other';
}
