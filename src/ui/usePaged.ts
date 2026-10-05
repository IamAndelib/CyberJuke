import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Track } from '../data/model';
import type { Cursor, Page } from '../data/source';
import { source } from '../data';
import { recordTracks } from '../store/genres';

export type Status = 'loading' | 'ready' | 'error';

export interface Paged {
  tracks: Track[];
  status: Status;
  error: { message: string; offline: boolean } | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  refresh: () => Promise<void>;
  retry: () => void;
}

/** Infinite, cursor-paged track list. `key` changes reset it. */
export function usePaged(key: string, loader: (cursor: Cursor | null) => Promise<Page>): Paged {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<Paged['error']>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const gen = useRef(0);
  const busy = useRef(false);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const toErr = (e: unknown) => ({
    message: e instanceof Error ? e.message : String(e),
    offline: !!(e as { offline?: boolean })?.offline || (typeof navigator !== 'undefined' && navigator.onLine === false),
  });

  const loadFirst = useCallback(async (soft: boolean) => {
    const g = ++gen.current;
    busy.current = true;
    if (!soft) {
      setStatus('loading');
      setTracks([]);
    }
    setError(null);
    try {
      const p = await loaderRef.current(null);
      if (g !== gen.current) return;
      recordTracks(p.tracks);
      setTracks(dedupe(p.tracks));
      setCursor(p.cursor);
      setStatus('ready');
    } catch (e) {
      if (g !== gen.current) return;
      setError(toErr(e));
      // A failed refresh keeps showing what we had.
      if (!soft) setStatus('error');
    } finally {
      if (g === gen.current) busy.current = false;
    }
  }, []);

  useEffect(() => {
    setCursor(null);
    void loadFirst(false);
  }, [key]);

  const loadMore = useCallback(() => {
    if (busy.current || !cursor) return;
    const g = gen.current;
    busy.current = true;
    setLoadingMore(true);
    loaderRef
      .current(cursor)
      .then((p) => {
        if (g !== gen.current) return;
        recordTracks(p.tracks);
        setTracks((prev) => dedupe([...prev, ...p.tracks]));
        setCursor(p.cursor);
        setError(null);
      })
      .catch((e) => {
        if (g === gen.current) setError(toErr(e));
      })
      .finally(() => {
        if (g === gen.current) {
          busy.current = false;
          setLoadingMore(false);
        }
      });
  }, [cursor]);

  const refresh = useCallback(async () => {
    source.invalidate?.();
    await loadFirst(true);
  }, []);

  return {
    tracks,
    status,
    error,
    hasMore: !!cursor,
    loadingMore,
    loadMore,
    refresh,
    retry: () => void loadFirst(false),
  };
}

function dedupe(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
}
