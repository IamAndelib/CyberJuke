/**
 * YouTube resilience state for the UI (Y1).
 *
 * - `blocked`: YouTube is refusing requests from this network (bot check, HTTP 429,
 *   a 403 on a fresh stream), after native tried IPv4 and one retry. Native pauses
 *   playback and backs off until `until`, then resumes by itself; the banner says when
 *   and offers "Try now". It clears on `unblocked` (also sent when the network or the
 *   IPv4 setting changes), or by itself once `until` has passed.
 * - `broken`: parsing failed in a way that means YouTube changed something; only an
 *   app update fixes that. Kept for the session.
 * Both can be dismissed; a new block (a later `until`) shows the banner again.
 */
import { computed, signal, type ReadonlySignal } from '@preact/signals';
import type { BlockReason, BlockedEvent } from '../player/native';
import type { NetStatus } from '../player/types';

interface BlockState {
  until: number;
  reason: BlockReason;
}

const REASONS: readonly BlockReason[] = ['BOT_CHECK', 'RATE_LIMIT', 'STREAM_FORBIDDEN'];

interface BlockDeps {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface BlockStore {
  blocked: ReadonlySignal<BlockState | null>;
  broken: ReadonlySignal<string | null>;
  /** The block the banner shows (null when none, or dismissed). */
  banner: ReadonlySignal<BlockState | null>;
  /** The "YouTube changed something" message shows (not dismissed). */
  brokenBanner: ReadonlySignal<boolean>;
  /** A track can't be played from here right now: offer "Open in YouTube". */
  degraded: ReadonlySignal<boolean>;
  onBlocked(e: Partial<BlockedEvent> | null | undefined): void;
  onUnblocked(): void;
  onExtractorBroken(e: { message?: unknown } | null | undefined): void;
  dismiss(): void;
  dismissBroken(): void;
}

export function createBlockStore(deps: BlockDeps = {}): BlockStore {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const blocked = signal<BlockState | null>(null);
  const broken = signal<string | null>(null);
  const dismissedUntil = signal(0);
  const brokenDismissed = signal(false);
  let timer: unknown = null;

  const stop = () => {
    if (timer != null) clearTimer(timer);
    timer = null;
  };

  const clear = () => {
    stop();
    blocked.value = null;
  };

  /**
   * Clears the block once `until` has passed. A timer can fire early (the clock was set
   * back, or a delay past what timers take): then it waits again.
   */
  const arm = () => {
    stop();
    const b = blocked.value;
    if (!b) return;
    const left = b.until - now();
    if (left <= 0) return clear();
    timer = setTimer(() => {
      timer = null;
      arm();
    }, Math.min(left, MAX_TIMER_MS));
  };

  return {
    blocked,
    broken,
    banner: computed(() => {
      const b = blocked.value;
      return b && b.until !== dismissedUntil.value ? b : null;
    }),
    brokenBanner: computed(() => broken.value != null && !brokenDismissed.value),
    degraded: computed(() => blocked.value != null || broken.value != null),
    onBlocked(e) {
      const until = Number(e?.until);
      if (!Number.isFinite(until) || until <= now()) return clear();
      const reason = REASONS.includes(e?.reason as BlockReason) ? (e!.reason as BlockReason) : 'BOT_CHECK';
      const cur = blocked.value;
      if (!cur || cur.until !== until || cur.reason !== reason) blocked.value = { until, reason };
      // Native sends `unblocked` too; this covers a missed event (the app was paused).
      arm();
    },
    onUnblocked: clear,
    onExtractorBroken(e) {
      const m = typeof e?.message === 'string' && e.message.trim() ? e.message.trim() : 'unknown';
      broken.value = m;
      brokenDismissed.value = false;
    },
    dismiss() {
      if (blocked.value) dismissedUntil.value = blocked.value.until;
    },
    dismissBroken() {
      brokenDismissed.value = true;
    },
  };
}

/** The longest delay setTimeout takes (2^31 - 1 ms); longer ones fire at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Ms until the whole minutes left (minutesLeft) next change. */
export function msToNextMinute(until: number, now: number): number {
  const left = until - now;
  if (left <= 0) return 60_000;
  return left % 60_000 || 60_000;
}

/** Whole minutes left, at least 1 while blocked. */
export function minutesLeft(until: number, now: number): number {
  return Math.max(1, Math.ceil((until - now) / 60_000));
}

/** The banner: what happened and when CyberJuke tries again by itself (it resumes playback then). */
export function blockedText(until: number, now: number): string {
  return `YouTube is limiting requests from your network. Trying again in ${minutesLeft(until, now)} min.`;
}

const REASON_TEXT: Record<string, string> = {
  BOT_CHECK: 'bot check',
  RATE_LIMIT: 'rate limit',
  STREAM_FORBIDDEN: 'stream refused',
};

/** "14:02": a time today, or "3 Oct 14:02" on another day (the device's locale). */
function when(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

/**
 * The Settings diagnostics line (for bug reports): "Connection: IPv4 (switched by Auto) ·
 * last limit 14:02, bot check (music)". Null when there is nothing to show (the web player).
 */
export function netStatusText(
  s: Pick<NetStatus, 'family' | 'autoIpv4' | 'lastLimit'> | null,
  now: number,
): string | null {
  if (!s) return null;
  // Auto's switch applies from the next request: say IPv4 even if the last one was IPv6.
  const family = s.autoIpv4 ? 'IPv4 (switched by Auto)' : (s.family ?? 'not used yet');
  const l = s.lastLimit;
  const limit = l
    ? `last limit ${when(l.at, now)}, ${REASON_TEXT[l.reason] ?? 'limit'}${l.surface === 'music' ? ' (music)' : ''}`
    : 'no limits so far';
  return `Connection: ${family} · ${limit}`;
}

export const BROKEN_TEXT = 'YouTube changed something. Update CyberJuke when a new version is out.';

/** The app's block state. */
export const block = createBlockStore();
