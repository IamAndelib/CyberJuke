/**
 * The app's new-tracks check (see ./freshness), wired to the Firestore source, the
 * catalog, the Home feeds and the "Check for new tracks" setting.
 */
import { effect } from '@preact/signals';
import { Capacitor } from '@capacitor/core';
import { source } from '../data';
import { FirestoreSource } from '../data/firestore';
import { feeds } from '../ui/feed';
import { catalog } from './catalog';
import { createFreshness } from './freshness';
import { settings } from './library';
import { online } from './network';

const fs = source instanceof FirestoreSource ? source : null;

export const freshness = createFreshness({
  newerThan: (since) => (fs ? fs.newerThan(since) : Promise.resolve({ count: 0, newest: null })),
  fallbackBaseline: () => catalog.all.value[0]?.createdAt ?? null,
  // New posts show up everywhere: the catalog (search, Artists, Most saved) adds them.
  onFound: () => void catalog.refresh({ force: true }),
  intervalMs: () => (settings.value.checkEvery > 0 ? settings.value.checkEvery * 60_000 : null),
  isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  isOnline: () => online.value,
});

if (fs) fs.onLatest = (newest) => freshness.seen(newest);

/** Home feeds share this key prefix (Home.tsx: `home:<m|p>:<genre>:<nsfw>`). */
export const HOME_FEED_PREFIX = 'home:';

/**
 * The pill was tapped: drop the cached Latest pages and the source cache, reload the
 * Home list on screen (others are dropped and reload when shown) and hide the pill.
 */
export async function refreshLatest(): Promise<void> {
  freshness.dismiss();
  fs?.invalidateAll();
  const jobs: Promise<void>[] = [];
  for (const [key, feed] of feeds.entries(HOME_FEED_PREFIX)) {
    if (feed.watched) jobs.push(feed.refresh());
    else feeds.delete(key);
  }
  await Promise.all(jobs);
}

/** Start the timer and follow foreground/background, connectivity and the setting. */
export function startFreshness(): void {
  freshness.start();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') freshness.resume();
    else freshness.pause();
  });
  let wasOnline = online.value;
  effect(() => {
    const now = online.value;
    if (now && !wasOnline) freshness.resume();
    wasOnline = now;
  });
  let last = settings.value.checkEvery;
  effect(() => {
    const v = settings.value.checkEvery;
    if (v !== last) {
      last = v;
      freshness.reschedule();
    }
  });
  if (!Capacitor.isNativePlatform()) {
    // Dev/e2e hook: run a check without waiting for the timer.
    (window as unknown as { __cyberjukeFreshness: unknown }).__cyberjukeFreshness = { check: () => freshness.check(), refreshLatest };
  }
}
