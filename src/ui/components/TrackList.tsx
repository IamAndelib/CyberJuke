import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Track } from '../../data/model';
import { catalog } from '../../stores/catalog';
import type { Paged } from '../usePaged';
import { useChunks } from '../useChunks';
import { Icon } from '../icons';
import { playAll, playFrom, type PlayCtx } from '../playAll';
import { SkeletonRows, TrackRow } from './TrackRow';

export { playFrom };

/**
 * What a row tap plays: `queue()` when given (P2: a feed's whole list, of which the
 * shown rows are the start, so row i is item i), else the rows themselves.
 */
function rowPlayer(tracks: Track[], ctx: PlayCtx, queue?: () => Track[]) {
  return (i: number) => () => void playFrom(queue ? queue() : tracks, i, ctx);
}

/**
 * A plain list of tracks; tapping one plays the list from there. Long lists render
 * in chunks of 60 as you scroll (`chunkKey` remembers how far, for scroll memory).
 */
export function Tracks({
  tracks,
  ctx,
  queue,
  hideGenre,
  showSaves,
  chunkKey = null,
}: {
  tracks: Track[];
  ctx: PlayCtx;
  queue?: () => Track[];
  hideGenre?: boolean;
  showSaves?: boolean;
  chunkKey?: string | null;
}) {
  const { shown, sentinel, more } = useChunks(tracks.length, chunkKey);
  const play = rowPlayer(tracks, ctx, queue);
  return (
    <>
      <ul class="list" data-testid="track-list">
        {tracks.slice(0, shown).map((t, i) => (
          <TrackRow key={t.id} track={t} index={i} hideGenre={hideGenre} showSaves={showSaves} onPlay={play(i)} />
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
export function ChunkedTracks({ tracks, ctx, chunkKey, testid }: { tracks: Track[]; ctx: PlayCtx; chunkKey: string; testid?: string }) {
  const { shown, sentinel, more } = useChunks(tracks.length, chunkKey);
  const play = rowPlayer(tracks, ctx);
  return (
    <div data-testid={testid}>
      <ul class="list" data-testid="track-list">
        {tracks.slice(0, shown).map((t, i) => (
          <TrackRow key={t.id} track={t} index={i} onPlay={play(i)} />
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

/** The Jukebox catalog couldn't load (or we're offline): say so, with Retry. */
export function CatalogError() {
  const err = catalog.error.value ?? { message: "Couldn't load the Jukebox.", offline: false };
  return <ErrorState {...err} onRetry={() => void catalog.refresh()} />;
}

/**
 * Paged list with skeleton, error/offline/empty states and infinite scroll. Loaded
 * pages render in chunks (`chunkKey` remembers how many rows were shown); the next
 * page is asked for only once every loaded row is on the page.
 */
export function PagedTracks({
  paged,
  ctx,
  queue,
  empty,
  hideGenre,
  chunkKey = null,
}: {
  paged: Paged;
  ctx: PlayCtx;
  queue?: () => Track[];
  empty?: ComponentChildren;
  hideGenre?: boolean;
  chunkKey?: string | null;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const { tracks, status, error, hasMore, loadingMore, loadMore } = paged;
  const chunks = useChunks(tracks.length, chunkKey);
  const play = rowPlayer(tracks, ctx, queue);

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
          <TrackRow key={t.id} track={t} index={i} hideGenre={hideGenre} onPlay={play(i)} />
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

/**
 * P3: the one Play / Shuffle pair, same labels everywhere. Play plays in order with
 * shuffle off; Shuffle turns shuffle on. `tracks` may be a getter (the whole list,
 * read at the tap).
 */
export function PlayShuffle({
  tracks,
  ctx,
  testid,
  disabled,
  playTestid = `${testid}-play`,
  shuffleTestid = `${testid}-shuffle`,
}: {
  tracks: Track[] | (() => Track[]);
  ctx: PlayCtx;
  testid: string;
  disabled?: boolean;
  playTestid?: string;
  shuffleTestid?: string;
}) {
  const get = () => (typeof tracks === 'function' ? tracks() : tracks);
  const none = disabled ?? !get().length;
  return (
    <div class="actions">
      <button class="btn primary" disabled={none} onClick={() => playAll(get(), { shuffle: false, ctx })} data-testid={playTestid}>
        <Icon name="play" size={18} /> Play
      </button>
      <button class="btn" disabled={none} onClick={() => playAll(get(), { shuffle: true, ctx })} data-testid={shuffleTestid}>
        <Icon name="shuffle" size={18} /> Shuffle
      </button>
    </div>
  );
}
