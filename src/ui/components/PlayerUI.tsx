import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { player, livePosition, type PlayerState } from '../../player';
import { isLiked, liked, toggleLike } from '../../store/library';
import { toast, toasts } from '../../store/toast';
import { Icon } from '../icons';
import { artistChoice, menuTrack, nowPlayingOpen, openArtistPage, openGenrePage, openPost } from '../nav';
import { splitArtists } from '../../data/artists';
import { isGlobal, type Track } from '../../data/model';
import { Art } from './Art';
import { LyricsPanel, lyricsOpen } from './Lyrics';
import { shareTrack } from '../share';

/** Re-render ~4x/s while playing so progress moves smoothly between samples. */
function useLivePosition(s: PlayerState): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!s.isPlaying || s.isBuffering) return;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [s.isPlaying, s.isBuffering]);
  return livePosition(s);
}

export function fmt(ms: number): string {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function PlayPauseIcon({ s, size }: { s: PlayerState; size: number }) {
  if (s.isPlaying && s.isBuffering) return <span class={'spinner' + (size > 30 ? ' big' : '')} aria-hidden="true" />;
  return <Icon name={s.isPlaying ? 'pause' : 'play'} size={size} />;
}

// ---- Mini player -------------------------------------------------------------------

export function MiniPlayer() {
  const s = player.state.value;
  const pos = useLivePosition(s);
  const t = s.current;
  if (!t) return null;
  const pct = s.durationMs > 0 ? Math.min(100, (pos / s.durationMs) * 100) : 0;
  return (
    <div class="mini" data-testid="mini-player">
      <div class="mini-progress" style={{ '--progress': `${pct}%` }} aria-hidden="true" />
      <button class="mini-open" onClick={() => (nowPlayingOpen.value = true)} aria-label={`Now playing: ${t.title} by ${t.artist}. Open player`} data-testid="mini-open">
        <Art track={t} size="sm" />
        <span class="mini-text">
          <span class="mini-title" data-testid="mini-title">
            {t.title}
          </span>
          <span class="mini-artist">{t.artist}</span>
        </span>
      </button>
      <button class="icon-btn" onClick={() => player.toggle()} aria-label={s.isPlaying ? 'Pause' : 'Play'} data-testid="mini-toggle">
        <PlayPauseIcon s={s} size={28} />
      </button>
      <button class="icon-btn" onClick={() => player.next()} aria-label="Next track" data-testid="mini-next" disabled={!s.upNext.length && s.repeat === 'off'}>
        <Icon name="next" size={28} />
      </button>
    </div>
  );
}

// ---- Now Playing -------------------------------------------------------------------

function SeekBar({ s }: { s: PlayerState }) {
  const live = useLivePosition(s);
  const [drag, setDrag] = useState<number | null>(null);
  const dur = s.durationMs;
  const pos = drag ?? live;
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  return (
    <div class="seek">
      <input
        type="range"
        class="seek-range"
        min={0}
        max={Math.max(1, dur)}
        step={1000}
        value={Math.min(pos, dur)}
        disabled={dur <= 0}
        style={{ '--progress': `${pct}%` }}
        aria-label="Seek"
        aria-valuetext={`${fmt(pos)} of ${fmt(dur)}`}
        onInput={(e) => setDrag(Number((e.target as HTMLInputElement).value))}
        onChange={(e) => {
          const v = Number((e.target as HTMLInputElement).value);
          setDrag(null);
          void player.seek(v);
        }}
        data-testid="seek"
      />
      <div class="seek-times">
        <span data-testid="time-pos">{fmt(pos)}</span>
        <span data-testid="time-dur">{dur > 0 ? fmt(dur) : '--:--'}</span>
      </div>
    </div>
  );
}

/** Close when dragged this share of the sheet's height, or flicked faster than this. */
export const SWIPE_CLOSE_FRACTION = 0.25;
export const SWIPE_CLOSE_VELOCITY = 0.5; // px/ms

/**
 * Swipe down to close Now Playing. A downward drag that starts while the sheet is
 * scrolled to the top (or on the grab handle) moves the sheet with the finger; release
 * past 25% of its height or with a flick closes it, otherwise it springs back.
 * The seek bar, the lyrics panel and horizontal drags are left alone.
 */
function useSwipeToClose(ref: { current: HTMLDivElement | null }): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let start: { x: number; y: number } | null = null;
    let dragging = false;
    let samples: { y: number; t: number }[] = [];
    let dy = 0;
    const scroller = () => el.querySelector<HTMLElement>('.np-scroll');
    const reset = () => {
      el.style.transform = '';
      el.style.transition = '';
      el.style.opacity = '';
    };
    const onStart = (e: TouchEvent) => {
      start = null;
      dragging = false;
      if (!nowPlayingOpen.value || e.touches.length !== 1) return;
      const target = e.target as HTMLElement;
      const onHandle = !!target.closest('.np-grab');
      if (!onHandle && target.closest('.seek, input, .lyr-scroll')) return;
      if (!onHandle && (scroller()?.scrollTop ?? 0) > 0) return;
      const p = e.touches[0];
      start = { x: p.clientX, y: p.clientY };
      samples = [{ y: p.clientY, t: e.timeStamp || performance.now() }];
      dy = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const p = e.touches[0];
      const dx = p.clientX - start.x;
      const d = p.clientY - start.y;
      if (!dragging) {
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(d)) return void (start = null); // horizontal
        if (d < -4) return void (start = null); // scrolling the content up
        if (d < 8) return;
        dragging = true;
        el.classList.add('dragging');
      }
      e.preventDefault();
      dy = Math.max(0, d);
      const t = e.timeStamp || performance.now();
      samples.push({ y: p.clientY, t });
      while (samples.length > 2 && t - samples[0].t > 100) samples.shift();
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      el.style.opacity = String(1 - Math.min(0.25, (dy / (el.clientHeight || 1)) * 0.4));
    };
    const onEnd = () => {
      if (!start) return;
      start = null;
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      const a = samples[0];
      const b = samples[samples.length - 1];
      const v = b && a && b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0;
      const close = dy > (el.clientHeight || 1) * SWIPE_CLOSE_FRACTION || v > SWIPE_CLOSE_VELOCITY;
      if (close) {
        const instant = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.style.transition = instant ? 'none' : '';
        el.style.transform = '';
        el.style.opacity = '';
        nowPlayingOpen.value = false;
        if (instant) requestAnimationFrame(() => (el.style.transition = ''));
      } else reset();
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, []);
}

const NEXT_REPEAT = { off: 'all', all: 'one', one: 'off' } as const;
const REPEAT_LABEL = { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' } as const;

export function NowPlaying() {
  const open = nowPlayingOpen.value;
  const s = player.state.value;
  const t = s.current;
  // Close the sheet if the queue empties.
  useEffect(() => {
    if (!t && open) nowPlayingOpen.value = false;
  }, [t, open]);
  void liked.value; // subscribe to like changes
  const isFav = t ? isLiked(t.id) : false;
  const sheet = useRef<HTMLDivElement>(null);
  useSwipeToClose(sheet);
  const showLyrics = lyricsOpen.value;

  return (
    <div
      ref={sheet}
      class={'np' + (open ? ' open' : '')}
      role="dialog"
      aria-modal="true"
      aria-label="Now playing"
      aria-hidden={!open}
      inert={!open}
      data-testid="now-playing"
    >
      {t && (
        <div class="np-scroll">
          <div class="np-grab" aria-hidden="true" data-testid="np-grab">
            <span />
          </div>
          <header class="np-head">
            <button class="icon-btn" onClick={() => (nowPlayingOpen.value = false)} aria-label="Close player" data-testid="np-close">
              <Icon name="down" />
            </button>
            <div class="np-head-title">
              <span class="np-kicker">Now playing</span>
              <span class="np-from">{s.queue.length > 1 ? `${s.index + 1} of ${s.queue.length}` : 'Single track'}</span>
            </div>
            <button class="icon-btn" onClick={() => (menuTrack.value = t)} aria-label="More options" data-testid="np-more">
              <Icon name="more" />
            </button>
          </header>

          <div class={'np-art dos' + (showLyrics ? ' lyrics' : '')}>
            <div class="dos-frame">
              {showLyrics ? (
                <LyricsPanel track={t} s={s} />
              ) : (
                <button class="np-art-btn" onClick={() => (lyricsOpen.value = true)} aria-label="Show lyrics" data-testid="np-art">
                  <Art track={t} size="fill" />
                </button>
              )}
              <button
                class="np-flip"
                onClick={() => (lyricsOpen.value = !showLyrics)}
                aria-pressed={showLyrics}
                aria-label={showLyrics ? 'Show album art' : 'Show lyrics'}
                data-testid="np-lyrics-toggle"
              >
                {showLyrics ? '[art]' : '[lyrics]'}
              </button>
            </div>
            <div class="dos-shadow" aria-hidden="true" />
          </div>

          <div class="np-meta">
            <div class="np-titles">
              <h2 class="np-title" data-testid="np-title">
                {t.title}
              </h2>
              <NpArtist track={t} />
              {t.genre && (
                <button class="tag np-genre" onClick={() => openGenrePage(t.genre)} aria-label={`Open genre ${t.genre}`} data-testid="np-genre">
                  {t.genre}
                </button>
              )}
            </div>
            <button
              class={'icon-btn like' + (isFav ? ' on' : '')}
              aria-pressed={isFav}
              aria-label={isFav ? 'Remove from liked' : 'Like'}
              onClick={() => toast(toggleLike(t) ? 'Added to Liked' : 'Removed from Liked', 1800)}
              data-testid="np-like"
            >
              <Icon name={isFav ? 'heart' : 'heartOutline'} size={28} />
            </button>
          </div>

          <SeekBar s={s} />

          <div class="np-controls">
            <button
              class={'icon-btn toggle-icon' + (s.shuffle ? ' on' : '')}
              aria-pressed={s.shuffle}
              aria-label={s.shuffle ? 'Shuffle on' : 'Shuffle off'}
              onClick={() => player.setShuffle(!s.shuffle)}
              data-testid="np-shuffle"
            >
              <Icon name="shuffle" />
            </button>
            <button class="icon-btn big" aria-label="Previous track" onClick={() => player.prev()} data-testid="np-prev">
              <Icon name="prev" size={36} />
            </button>
            <button class="play-btn" aria-label={s.isPlaying ? 'Pause' : 'Play'} onClick={() => player.toggle()} data-testid="np-toggle">
              <PlayPauseIcon s={s} size={40} />
            </button>
            <button class="icon-btn big" aria-label="Next track" onClick={() => player.next()} data-testid="np-next">
              <Icon name="next" size={36} />
            </button>
            <button
              class={'icon-btn toggle-icon' + (s.repeat !== 'off' ? ' on' : '')}
              aria-label={REPEAT_LABEL[s.repeat]}
              onClick={() => player.setRepeat(NEXT_REPEAT[s.repeat])}
              data-testid="np-repeat"
              data-mode={s.repeat}
            >
              <Icon name={s.repeat === 'one' ? 'repeatOne' : 'repeat'} />
            </button>
          </div>

          {isGlobal(t) ? (
            <div class="np-post np-global" data-testid="np-global">
              <span>From Global search</span>
              <Icon name="search" size={18} />
            </div>
          ) : t.by && (
            <button class="np-post" onClick={() => openPost(t.postUrl)} data-testid="np-post">
              <span>
                Posted by <b>@{t.by}</b>
                {t.postTitle && <span class="np-post-title">“{t.postTitle}”</span>}
              </span>
              <Icon name="external" size={18} />
            </button>
          )}

          <UpNext s={s} />
        </div>
      )}
    </div>
  );
}

/** Artist line in Now Playing: tapping opens the artist page (or a chooser for several). */
function NpArtist({ track }: { track: Track }) {
  const names = splitArtists(track.artist);
  if (!names.length) return <div class="np-artist">{track.artist}</div>;
  return (
    <div class="np-artist">
      <button
        class="np-link"
        onClick={() => (names.length === 1 ? openArtistPage(names[0]) : (artistChoice.value = names))}
        aria-label={names.length === 1 ? `Open artist ${names[0]}` : `Choose an artist: ${names.join(', ')}`}
        aria-haspopup={names.length > 1 ? 'dialog' : undefined}
        data-testid="np-artist"
      >
        {track.artist}
      </button>
    </div>
  );
}

/** Small sheet listing a track's credited artists (from Now Playing). */
export function ArtistChooser() {
  const names = artistChoice.value;
  const close = () => (artistChoice.value = null);
  return (
    <div class={'sheet-wrap' + (names ? ' open' : '')} aria-hidden={!names} inert={!names}>
      <div class="scrim" onClick={close} />
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Choose an artist" data-testid="artist-chooser">
        {names && (
          <>
            <div class="sheet-head">
              <span class="section-title">Artists</span>
            </div>
            {names.map((n) => (
              <button key={n} class="sheet-item" onClick={() => openArtistPage(n)} data-testid="chooser-artist">
                <Icon name="artists" size={20} /> <span class="sheet-text">{n}</span>
              </button>
            ))}
            <button class="sheet-item cancel" onClick={close}>
              [Cancel]
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function UpNext({ s }: { s: PlayerState }) {
  const items = s.upNext;
  const canReorder = !s.shuffle;
  return (
    <section class="upnext" data-testid="up-next">
      <div class="section-head">
        <h3 class="section-title">Up next</h3>
        <span class="dim small">{s.shuffle ? 'Shuffled · turn shuffle off to reorder' : `${items.length} track${items.length === 1 ? '' : 's'}`}</span>
      </div>
      {items.length === 0 ? (
        <div class="dim small upnext-empty">{s.repeat === 'all' ? 'Queue repeats from the top.' : 'Nothing queued. ⋯ → Add to queue plays a track next.'}</div>
      ) : (
        <ol class="list compact">
          {items.map(({ track, index, queued }, k) => (
            <Fragment key={`${track.id}:${index}`}>
              {k === 0 && queued && (
                <li class="upnext-label" data-testid="upnext-queued-label" aria-hidden="true">
                  Queued by you
                </li>
              )}
              {!queued && k > 0 && items[k - 1].queued && (
                <li class="upnext-label" aria-hidden="true">
                  Next from the list
                </li>
              )}
              <li class={'row' + (queued ? ' queued' : '')} data-testid="upnext-row" data-queued={queued ? 'true' : undefined}>
                <button class="row-main" onClick={() => player.skipTo(index)} aria-label={`Play ${track.title}${queued ? ', queued by you' : ''}`}>
                  <div class="row-art">
                    <Art track={track} size="sm" />
                  </div>
                  <div class="row-text">
                    <div class="row-title">{track.title}</div>
                    <div class="row-artist">{track.artist}</div>
                  </div>
                </button>
                {canReorder && (
                  <>
                    <button
                      class="icon-btn sm"
                      aria-label={`Move ${track.title} up`}
                      disabled={k === 0}
                      onClick={() => player.move(index, items[k - 1].index)}
                      data-testid="upnext-up"
                    >
                      <Icon name="up" size={20} />
                    </button>
                    <button
                      class="icon-btn sm"
                      aria-label={`Move ${track.title} down`}
                      disabled={k === items.length - 1}
                      onClick={() => player.move(index, items[k + 1].index)}
                      data-testid="upnext-down"
                    >
                      <Icon name="down" size={20} />
                    </button>
                  </>
                )}
                <button class="icon-btn sm" aria-label={`Remove ${track.title} from queue`} onClick={() => player.remove(index)} data-testid="upnext-remove">
                  <Icon name="close" size={20} />
                </button>
              </li>
            </Fragment>
          ))}
        </ol>
      )}
    </section>
  );
}

// ---- Track ⋯ menu ------------------------------------------------------------------

export function TrackMenu() {
  const t = menuTrack.value;
  void liked.value;
  const close = () => (menuTrack.value = null);
  const fav = t ? isLiked(t.id) : false;
  return (
    <div class={'sheet-wrap' + (t ? ' open' : '')} aria-hidden={!t} inert={!t}>
      <div class="scrim" onClick={close} />
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Track options" data-testid="track-menu">
        {t && (
          <>
            <div class="sheet-head">
              <Art track={t} size="sm" />
              <div class="row-text">
                <div class="row-title">{t.title}</div>
                <div class="row-artist">{t.artist}</div>
              </div>
            </div>
            <button
              class="sheet-item"
              onClick={() => {
                const playing = !!player.state.value.current;
                void player.addToQueue([t]);
                toast(playing ? 'Added to queue · plays next' : 'Playing');
                close();
              }}
              data-testid="menu-add-queue"
            >
              <Icon name="playNext" size={20} /> Add to queue
            </button>
            <button
              class="sheet-item"
              onClick={() => {
                close();
                void shareTrack(t);
              }}
              data-testid="menu-share"
            >
              <Icon name="share" size={20} /> Share
            </button>
            <button
              class="sheet-item"
              onClick={() => {
                toast(toggleLike(t) ? 'Added to Liked' : 'Removed from Liked', 1800);
                close();
              }}
              data-testid="menu-like"
            >
              <Icon name={fav ? 'heart' : 'heartOutline'} size={20} /> {fav ? 'Unlike' : 'Like'}
            </button>
            {splitArtists(t.artist).map((n) => (
              <button key={n} class="sheet-item" onClick={() => openArtistPage(n)} data-testid="menu-more-by">
                <Icon name="artists" size={20} /> <span class="sheet-text">More by {n}</span>
              </button>
            ))}
            {!isGlobal(t) && t.postUrl && (
              <button
                class="sheet-item"
                onClick={() => {
                  openPost(t.postUrl);
                  close();
                }}
                data-testid="menu-open-post"
              >
                <Icon name="external" size={20} /> <span class="sheet-text">Open post{t.by ? ` by @${t.by}` : ''}</span>
              </button>
            )}
            <button class="sheet-item cancel" onClick={close}>
              [Cancel]
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---- Toasts ------------------------------------------------------------------------

export function Toasts() {
  return (
    <div class="toasts" aria-live="polite" data-testid="toasts">
      {toasts.value.map((t) => (
        <div class="toast" key={t.id} data-testid="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}
