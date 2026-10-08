/**
 * "New tracks" check. Instead of a feed that silently goes stale (or changes under
 * your thumb), a cheap request asks Firestore whether anything is newer than the
 * newest post shown on Home; if so, Home shows a pill. The feed itself never changes
 * until the pill (or pull-to-refresh) is tapped.
 *
 * When it runs: every `intervalMs()` while the app is in the foreground, on resume and
 * on coming back online. Never in the background. "Only when I refresh" (interval
 * null) turns the timer and the resume/online checks off.
 *
 * The request: the Jukebox query with a createdAt-only field mask,
 * `createdAt > newest shown`, limit 25 (see FirestoreSource.newerThan).
 */
import { signal, type ReadonlySignal } from '@preact/signals';

export interface NewTracks {
  /** How many are newer (capped at the query limit). */
  count: number;
  /** createdAt of the newest one. */
  newest: string;
}

export interface FreshnessDeps {
  newerThan(since: string): Promise<{ count: number; newest: string | null }>;
  /** Fallback baseline when the Latest feed hasn't loaded yet (e.g. the catalog's newest). */
  fallbackBaseline(): string | null;
  /** The check found something new (the catalog does its incremental update). */
  onFound?(r: NewTracks): void;
  /** Milliseconds between checks, or null for "only when I refresh". */
  intervalMs(): number | null;
  isVisible(): boolean;
  isOnline?(): boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/** A resume or reconnect within this long of the last check doesn't check again. */
export const RESUME_MIN_MS = 60 * 1000;

export interface Freshness {
  /** What the pill shows; null hides it. */
  pending: ReadonlySignal<NewTracks | null>;
  /** The newest createdAt shown on the Latest feed (pill clears if it covers `pending`). */
  seen(newest: string): void;
  /** Run the check now (no-op while one is running or without a baseline). */
  check(): Promise<void>;
  /** Hide the pill (it was tapped). */
  dismiss(): void;
  /** Start the timer (call once at startup). */
  start(): void;
  /** The app came to the foreground or back online. */
  resume(): void;
  /** The app went to the background. */
  pause(): void;
  /** The interval setting changed. */
  reschedule(): void;
  readonly lastCheckAt: number;
}

export function createFreshness(deps: FreshnessDeps): Freshness {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const pending = signal<NewTracks | null>(null);
  let shown: string | null = null;
  let timer: unknown = null;
  let lastCheckAt = 0;
  let running: Promise<void> | null = null;
  let started = false;

  const baseline = () => shown ?? deps.fallbackBaseline();

  function stopTimer(): void {
    if (timer != null) clearTimer(timer);
    timer = null;
  }

  function schedule(): void {
    stopTimer();
    if (!started) return;
    const ms = deps.intervalMs();
    if (ms == null || ms <= 0 || !deps.isVisible()) return;
    const wait = Math.max(0, lastCheckAt + ms - now());
    timer = setTimer(() => {
      timer = null;
      void check().finally(schedule);
    }, wait);
  }

  function check(): Promise<void> {
    if (running) return running;
    const base = baseline();
    if (!base) return Promise.resolve();
    if (deps.isOnline && !deps.isOnline()) return Promise.resolve();
    lastCheckAt = now();
    running = deps
      .newerThan(base)
      .then((r) => {
        // The baseline may have moved on while the request was out.
        const cur = baseline();
        if (r.count > 0 && r.newest && (!cur || r.newest > cur)) {
          const found = { count: r.count, newest: r.newest };
          const before = pending.value;
          if (!before || before.newest !== found.newest || before.count !== found.count) pending.value = found;
          if (!before || before.newest !== found.newest) deps.onFound?.(found);
        } else if (pending.value && cur && pending.value.newest <= cur) {
          pending.value = null;
        }
      })
      .catch(() => {
        /* a failed check just waits for the next one */
      })
      .finally(() => (running = null));
    return running;
  }

  return {
    pending,
    seen(newest) {
      if (!shown || newest > shown) shown = newest;
      if (pending.value && pending.value.newest <= newest) pending.value = null;
    },
    check,
    dismiss() {
      pending.value = null;
    },
    start() {
      if (started) return;
      started = true;
      lastCheckAt = now(); // the feed was just loaded
      schedule();
    },
    resume() {
      if (!started) return;
      const ms = deps.intervalMs();
      if (ms == null || ms <= 0) return stopTimer();
      if (now() - lastCheckAt >= RESUME_MIN_MS) void check().finally(schedule);
      else schedule();
    },
    pause() {
      stopTimer();
    },
    reschedule() {
      schedule();
    },
    get lastCheckAt() {
      return lastCheckAt;
    },
  };
}
