import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Track } from '../../data/model';
import { player } from '../../player';
import type { Paged } from '../usePaged';
import { Icon } from '../icons';
import { SkeletonRows, TrackRow } from './TrackRow';

export function playFrom(tracks: Track[], i: number): void {
  void player.playList(tracks, i);
}

/** A plain list of tracks; tapping one plays the list from there. */
export function Tracks({ tracks, hideGenre, showSaves }: { tracks: Track[]; hideGenre?: boolean; showSaves?: boolean }) {
  return (
    <ul class="list" data-testid="track-list">
      {tracks.map((t, i) => (
        <TrackRow key={t.id} track={t} index={i} hideGenre={hideGenre} showSaves={showSaves} onPlay={() => playFrom(tracks, i)} />
      ))}
    </ul>
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

/** Paged list with skeleton, error/offline/empty states and infinite scroll. */
export function PagedTracks({ paged, empty, hideGenre }: { paged: Paged; empty?: ComponentChildren; hideGenre?: boolean }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const { tracks, status, error, hasMore, loadingMore, loadMore } = paged;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || status !== 'ready') return;
    // Re-observing after each page fires the callback again if the sentinel is still visible.
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && loadMore(), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [tracks.length, hasMore, status, loadMore]);

  if (status === 'loading') return <SkeletonRows />;
  if (status === 'error' && error) return <ErrorState {...error} onRetry={paged.retry} />;
  if (!tracks.length && !hasMore) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;

  return (
    <>
      <Tracks tracks={tracks} hideGenre={hideGenre} />
      {hasMore && (
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
      {!hasMore && tracks.length > 0 && <div class="list-foot end">— end of tape —</div>}
    </>
  );
}
