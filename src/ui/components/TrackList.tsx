import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Track } from '../../data/model';
import { player } from '../../player';
import type { Paged } from '../usePaged';
import { useChunks } from '../useChunks';
import { Icon } from '../icons';
import { SkeletonRows, TrackRow } from './TrackRow';

export function playFrom(tracks: Track[], i: number): void {
  void player.playList(tracks, i);
}

/**
 * A plain list of tracks; tapping one plays the list from there. Long lists render
 * in chunks of 60 as you scroll (`chunkKey` remembers how far, for scroll memory).
 */
export function Tracks({
  tracks,
  hideGenre,
  showSaves,
  chunkKey = null,
}: {
  tracks: Track[];
  hideGenre?: boolean;
  showSaves?: boolean;
  chunkKey?: string | null;
}) {
  const { shown, sentinel, more } = useChunks(tracks.length, chunkKey);
  return (
    <>
      <ul class="list" data-testid="track-list">
        {tracks.slice(0, shown).map((t, i) => (
          <TrackRow key={t.id} track={t} index={i} hideGenre={hideGenre} showSaves={showSaves} onPlay={() => playFrom(tracks, i)} />
        ))}
      </ul>
      {more && <div ref={sentinel} class="list-foot" aria-hidden="true" />}
    </>
  );
}

/**
 * A long list rendered in chunks of 60 as you scroll; tapping a row plays the whole
 * list from there. `chunkKey` remembers how many rows were shown (scroll memory).
 */
export function ChunkedTracks({ tracks, chunkKey, testid }: { tracks: Track[]; chunkKey: string; testid?: string }) {
  const { shown, sentinel, more } = useChunks(tracks.length, chunkKey);
  return (
    <div data-testid={testid}>
      <ul class="list" data-testid="track-list">
        {tracks.slice(0, shown).map((t, i) => (
          <TrackRow key={t.id} track={t} index={i} onPlay={() => playFrom(tracks, i)} />
        ))}
      </ul>
      {more ? <div ref={sentinel} class="list-foot" aria-hidden="true" /> : <div class="list-foot end">— end of tape —</div>}
    </div>
  );
}

export function EmptyState({ title, children, testid = 'empty' }: { title: string; children?: ComponentChildren; testid?: string }) {
  return (
    <div class="state" data-testid={testid}>
      <div class="state-glyph" aria-hidden="true">
        ¯\_(ツ)_/¯
      </div>
      <div class="state-title">{title}</div>
      {children && <div class="state-body">{children}</div>}
    </div>
  );
}

export function ErrorState({ offline, message, onRetry }: { offline: boolean; message: string; onRetry: () => void }) {
  return (
    <div class="state" data-testid={offline ? 'offline' : 'error'} role="alert">
      <div class="state-glyph" aria-hidden="true">
        {offline ? '[ NO CARRIER ]' : '[ ERROR ]'}
      </div>
      <div class="state-title">{offline ? "You're offline" : "Couldn't load the Jukebox"}</div>
      <div class="state-body">{offline ? 'Check your connection and try again.' : message}</div>
      <button class="btn" onClick={onRetry} data-testid="retry">
        <Icon name="refresh" size={18} /> Retry
      </button>
    </div>
  );
}

/**
 * Paged list with skeleton, error/offline/empty states and infinite scroll. Loaded
 * pages render in chunks (`chunkKey` remembers how many rows were shown); the next
 * page is asked for only once every loaded row is on the page.
 */
export function PagedTracks({ paged, empty, hideGenre, chunkKey = null }: { paged: Paged; empty?: ComponentChildren; hideGenre?: boolean; chunkKey?: string | null }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const { tracks, status, error, hasMore, loadingMore, loadMore } = paged;
  const chunks = useChunks(tracks.length, chunkKey);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || status !== 'ready' || chunks.more) return;
    // Re-observing after each page fires the callback again if the sentinel is still visible.
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && loadMore(), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [tracks.length, hasMore, status, loadMore, chunks.more]);

  if (status === 'loading') return <SkeletonRows />;
  if (status === 'error' && error) return <ErrorState {...error} onRetry={paged.retry} />;
  if (!tracks.length && !hasMore) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;

  return (
    <>
      <ul class="list" data-testid="track-list">
        {tracks.slice(0, chunks.shown).map((t, i) => (
          <TrackRow key={t.id} track={t} index={i} hideGenre={hideGenre} onPlay={() => playFrom(tracks, i)} />
        ))}
      </ul>
      {chunks.more && <div ref={chunks.sentinel} class="list-foot" aria-hidden="true" />}
      {hasMore && !chunks.more && (
        <div ref={sentinel} class="list-foot">
          {error && !loadingMore ? (
            <button class="btn" onClick={loadMore}>
              <Icon name="refresh" size={18} /> Retry loading more
            </button>
          ) : (
            <span class="loading-text">
              <span class="spinner" aria-hidden="true" /> Loading more…
            </span>
          )}
        </div>
      )}
      {!hasMore && !chunks.more && tracks.length > 0 && <div class="list-foot end">— end of tape —</div>}
    </>
  );
}
