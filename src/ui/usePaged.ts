import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import type { Track } from '../data/model';
import type { Cursor, Page } from '../data/source';
import { source } from '../data';
import { recordTracks } from '../stores/genres';
import { sayRefreshFailed } from './refresh';
import type { LoadError } from '../core/errors';
import { feeds, type Feed, type FeedCache, type FeedLoader, type FeedOptions, type FeedSnapshot, type FeedStatus } from '../stores/feed';


export interface Paged {
  tracks: Track[];
  status: FeedStatus;
  error: LoadError | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  refresh: () => Promise<void>;
  retry: () => void;
}

/**
 * Subscribe to a cached Feed: re-render on changes, load the first page if needed.
 * Rendering only looks the feed up (`obtain`); marking it used, evicting others and
 * swapping in the latest loader happen in effects.
 */
export function useFeed<T, C, M = undefined>(
  key: string,
  loader: FeedLoader<T, C, M>,
  opts?: FeedOptions<T>,
  cache: FeedCache = feeds,
): { feed: Feed<T, C, M>; snap: FeedSnapshot<T, M> } {
  const feed = cache.obtain(key, loader, opts);
  const [, force] = useState(0);
  // Same key = same request: the newest closure loads the next page.
  useLayoutEffect(() => {
    feed.loader = loader;
  });
  useEffect(() => {
    const un = feed.subscribe(() => force((n) => n + 1));
    cache.touch(key);
    feed.start();
    return un;
  }, [feed, cache, key]);
  return { feed, snap: feed.snapshot };
}

const TRACK_OPTS: FeedOptions<Track> = { onPage: recordTracks, id: (t) => t.id };

/**
 * Infinite, cursor-paged track list. Pages live in a module-level cache per `key`, so a
 * remount (tab switch, back from a genre) shows everything already loaded at once.
 */
export function usePaged(key: string, loader: (cursor: Cursor | null) => Promise<Page>): Paged {
  const { feed, snap } = useFeed<Track, Cursor>(
    key,
    (c) => loader(c).then((p) => ({ items: p.tracks, cursor: p.cursor })),
    TRACK_OPTS,
  );
  return {
    tracks: snap.items,
    status: snap.status,
    error: snap.error,
    hasMore: snap.hasMore,
    loadingMore: snap.loadingMore,
    loadMore: () => feed.loadMore(),
    refresh: async () => {
      source.invalidate?.();
      sayRefreshFailed(await feed.refresh());
    },
    retry: () => feed.retry(),
  };
}
