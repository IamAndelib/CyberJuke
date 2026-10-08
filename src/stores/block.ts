/**
 * YouTube resilience state for the UI (Y1).
 *
 * - `blocked`: YouTube is refusing requests from this network (bot check, HTTP 429,
 *   a 403 on a fresh stream). Native pauses playback and backs off until `until`;
 *   the banner says when to try again. It clears on `unblocked`, or by itself once
 *   `until` has passed.
 * - `broken`: parsing failed in a way that means YouTube changed something; only an
 *   app update fixes that. Kept for the session.
 * Both can be dismissed; a new block (a later `until`) shows the banner again.
 */
import { computed, signal, type ReadonlySignal } from '@preact/signals';
import type { BlockReason, BlockedEvent } from '../player/native';

export interface BlockState {
  until: number;
  reason: BlockReason;
}

const REASONS: readonly BlockReason[] = ['BOT_CHECK', 'RATE_LIMIT', 'STREAM_FORBIDDEN'];

export interface BlockDeps {
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
      stop();
      // Native sends `unblocked` too; this covers a missed event (the app was paused).
      timer = setTimer(() => {
        timer = null;
        if (blocked.value && blocked.value.until <= now()) blocked.value = null;
      }, until - now());
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

/** Whole minutes left, at least 1 while blocked. */
export function minutesLeft(until: number, now: number): number {
  return Math.max(1, Math.ceil((until - now) / 60_000));
}

export function blockedText(until: number, now: number): string {
  return `YouTube is limiting requests from your network. Try again in ${minutesLeft(until, now)} min, or switch between Wi-Fi and mobile data.`;
}

export const BROKEN_TEXT = 'YouTube changed something. Update CyberJuke when a new version is out.';
export const RELEASES_URL = 'https://github.com/IamAndelib/CyberJuke/releases';

/** The app's block state. */
export const block = createBlockStore();
