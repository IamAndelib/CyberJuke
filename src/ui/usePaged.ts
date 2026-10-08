import { useEffect, useState } from 'preact/hooks';
import type { Track } from '../data/model';
import type { Cursor, Page } from '../data/source';
import { source } from '../data';
import { recordTracks } from '../store/genres';
import { feeds, type Feed, type FeedCache, type FeedError, type FeedLoader, type FeedOptions, type FeedSnapshot, type FeedStatus } from './feed';

export type Status = FeedStatus;

export interface Paged {
  tracks: Track[];
  status: Status;
  error: FeedError | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  refresh: () => Promise<void>;
  retry: () => void;
}

/** Subscribe to a cached Feed: re-render on changes, load the first page if needed. */
export function useFeed<T, C, M = undefined>(
  key: string,
  loader: FeedLoader<T, C, M>,
  opts?: FeedOptions<T>,
  cache: FeedCache = feeds,
): { feed: Feed<T, C, M>; snap: FeedSnapshot<T, M> } {
  const feed = cache.get(key, loader, opts);
  const [, force] = useState(0);
  useEffect(() => {
    const un = feed.subscribe(() => force((n) => n + 1));
    feed.start();
    return un;
  }, [feed]);
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
      await feed.refresh();
    },
    retry: () => feed.retry(),
  };
}
