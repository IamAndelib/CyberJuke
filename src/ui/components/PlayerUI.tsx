import { useEffect, useRef, useState } from 'preact/hooks';
import { canSkipNext, currentTrack, hasCurrent, isAdvancing, isBuffering, isPlaying, livePosition, playContext, player, upNextSections, type PlayerState } from '../../player';
import { block } from '../../store/block';
import { isLiked, liked } from '../../store/library';
import { toggleLikeWithUndo } from '../../store/undo';
import { toast } from '../../store/toast';
import { Icon } from '../icons';
import { artistChoice, menuTrack, nowPlayingOpen, openArtistPage, openGenrePage } from '../nav';
import { openExternal, openPost, youtubeUrl } from '../links';
import { positionNow, useLiveProgress, useTickValue } from '../useTick';
import { splitArtists } from '../../data/artists';
import { isGlobal, type Track } from '../../data/model';
import { reducedMotion } from '../../core/motion';
import { Art } from './Art';
import { Marquee } from './Marquee';
import { MembersTag } from './TrackRow';
import { LyricsPanel, lyricsOpen } from './Lyrics';
import { UpNext } from './UpNext';
import { canSharePost, sharePost, shareTrack } from '../share';

export function fmt(ms: number): string {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Play/pause glyph (a spinner while starting); reads only the play state. */
function PlayPauseIcon({ size }: { size: number }) {
  if (isPlaying.value && isBuffering.value) return <span class={'spinner' + (size > 30 ? ' big' : '')} aria-hidden="true" />;
  return <Icon name={isPlaying.value ? 'pause' : 'play'} size={size} />;
}

// ---- Mini player -------------------------------------------------------------------

/**
 * The thin progress line: the fill's scaleX is written straight to its style on every
 * sample and tick, so playback re-renders nothing and only the compositor works.
 */
function MiniProgress() {
  const fill = useRef<HTMLDivElement>(null);
  useLiveProgress((pos, dur) => {
    const f = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0;
    if (fill.current) fill.current.style.transform = `scaleX(${f.toFixed(4)})`;
  }, isAdvancing.value);
  return (
    <div class="mini-progress" aria-hidden="true" data-testid="mini-progress">
      <div class="mini-progress-fill" ref={fill} />
    </div>
  );
}

function MiniToggle() {
  return (
    <button class="icon-btn" onClick={() => player.toggle()} aria-label={isPlaying.value ? 'Pause' : 'Play'} data-testid="mini-toggle">
      <PlayPauseIcon size={28} />
    </button>
  );
}

/** The mini player's title: it scrolls when too long, except under Now Playing. */
function MiniTitle({ text }: { text: string }) {
  return (
    <span class="mini-title" data-testid="mini-title">
      <Marquee text={text} active={!nowPlayingOpen.value} />
    </span>
  );
}

/** "Next" in the mini player and Now Playing alike: off at the end of the queue (canSkipNext). */
function NextButton({ size, class: cls, testid }: { size: number; class: string; testid: string }) {
  return (
    <button class={cls} onClick={() => player.next()} aria-label="Next track" data-testid={testid} disabled={!canSkipNext.value}>
      <Icon name="next" size={size} />
    </button>
  );
}

/** A swipe up this far on the mini player (more up than sideways) opens Now Playing. */
export const MINI_SWIPE_PX = 32;

/**
 * Swipe up on the mini player to open Now Playing (P11). Sideways swipes do nothing (no
 * next/previous: too easy to set off while scrolling). Passive listeners.
 */
function useSwipeUpToOpen(ref: { current: HTMLDivElement | null }): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let start: { x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const dx = e.touches[0].clientX - start.x;
      const dy = e.touches[0].clientY - start.y;
      if (Math.abs(dx) > MINI_SWIPE_PX && Math.abs(dx) > Math.abs(dy)) return void (start = null);
      if (-dy >= MINI_SWIPE_PX && -dy > Math.abs(dx) * 1.5) {
        start = null;
        nowPlayingOpen.value = true;
      }
    };
    const onEnd = () => (start = null);
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
    // Mount-only: `ref` is a stable ref to the mini player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function MiniPlayer() {
  const t = currentTrack.value;
  return t ? <MiniBar track={t} /> : null;
}

function MiniBar({ track: t }: { track: Track }) {
  const bar = useRef<HTMLDivElement>(null);
  useSwipeUpToOpen(bar);
  return (
    <div class="mini" ref={bar} data-testid="mini-player">
      <MiniProgress />
      <button class="mini-open" onClick={() => (nowPlayingOpen.value = true)} aria-label={`Now playing: ${t.title} by ${t.artist}. Open player`} data-testid="mini-open">
        <Art track={t} size="sm" />
        <span class="mini-text">
          <MiniTitle text={t.title} />
          <span class="mini-artist">{t.artist}</span>
        </span>
      </button>
      <MiniToggle />
      <NextButton size={28} class="icon-btn" testid="mini-next" />
    </div>
  );
}

// ---- Now Playing -------------------------------------------------------------------

function SeekBar({ s }: { s: PlayerState }) {
  // Re-renders once a second while playing (the time shown), not every frame.
  useTickValue(s.isPlaying && !s.isBuffering, () => Math.floor(positionNow() / 1000));
  const live = livePosition(s);
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
        const instant = reducedMotion();
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
    // Mount-only: `ref` is a stable ref object to the sheet, which never remounts (UX rework pending).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const NEXT_REPEAT = { off: 'all', all: 'one', one: 'off' } as const;
const REPEAT_LABEL = { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' } as const;

/** How long the sheet's contents stay after closing: the slide-down (0.2s) plus a margin. */
export const NP_UNMOUNT_MS = 400;

/**
 * The Now Playing sheet. Its contents exist only while it is open (and while it
 * slides away), so a closed sheet costs nothing during playback and fetches no lyrics.
 */
export function NowPlaying() {
  const open = nowPlayingOpen.value;
  const has = hasCurrent.value;
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) return setClosing(true);
    const id = setTimeout(() => setClosing(false), NP_UNMOUNT_MS);
    return () => clearTimeout(id);
  }, [open]);
  // Close the sheet if the queue empties.
  useEffect(() => {
    if (!has && open) nowPlayingOpen.value = false;
  }, [has, open]);
  const sheet = useRef<HTMLDivElement>(null);
  useSwipeToClose(sheet);

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
      {has && (open || closing) && <NowPlayingContent />}
    </div>
  );
}

function NowPlayingContent() {
  const s = player.state.value;
  const t = s.current;
  void liked.value; // subscribe to like changes
  const isFav = t ? isLiked(t.id) : false;
  const showLyrics = lyricsOpen.value;
  return (
    <>
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
              <NpFrom s={s} />
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
                <Marquee text={t.title} />
              </h2>
              <NpArtist track={t} />
              {t.membersOnly && <MembersTag class="np-members" />}
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
              onClick={() => toggleLikeWithUndo(t)}
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
              <PlayPauseIcon size={40} />
            </button>
            <NextButton size={36} class="icon-btn big" testid="np-next" />
            <button
              class={'icon-btn toggle-icon' + (s.repeat !== 'off' ? ' on' : '')}
              aria-pressed={s.repeat !== 'off'}
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
    </>
  );
}

/**
 * Under "Now playing": where the music comes from (P8), "Playing from Home · Latest",
 * or "Radio · <seed>" for a radio. Without shuffle the position ("3 of 50") comes
 * first; under shuffle the position means little, so only the source shows.
 */
function NpFrom({ s }: { s: PlayerState }) {
  const ctx = playContext.value;
  const seed = upNextSections.value.seed;
  const from = !ctx?.label ? '' : ctx.mode === 'radio' ? `Radio · ${seed?.title || ctx.label}` : `Playing from ${ctx.label}`;
  const pos = s.queue.length > 1 ? `${s.index + 1} of ${s.queue.length}` : 'Single track';
  const text = s.shuffle && from ? from : from ? `${pos} · ${from}` : pos;
  return (
    <span class="np-from" data-testid="np-from">
      <Marquee text={text} />
    </span>
  );
}

/** Artist line in Now Playing: tapping opens the artist page (or a chooser for several). */
function NpArtist({ track }: { track: Track }) {
  const names = splitArtists(track.artist);
  if (!names.length)
    return (
      <div class="np-artist">
        <Marquee text={track.artist} />
      </div>
    );
  return (
    <div class="np-artist">
      <button
        class="np-link"
        onClick={() => (names.length === 1 ? openArtistPage(names[0]) : (artistChoice.value = names))}
        aria-label={names.length === 1 ? `Open artist ${names[0]}` : `Choose an artist: ${names.join(', ')}`}
        aria-haspopup={names.length > 1 ? 'dialog' : undefined}
        data-testid="np-artist"
      >
        <Marquee text={track.artist} />
      </button>
    </div>
  );
}

/** Longest a closing sheet keeps its content if no transitionend comes (hidden page, no transition). */
const SHEET_CLEAR_MS = 400;

/**
 * What a bottom sheet shows: `value` while open, and the last one while it slides away,
 * until the sheet's transform transition ends. So it never collapses to an empty strip
 * on the way out.
 */
function useSheetContent<T>(value: T | null, sheet: { current: HTMLElement | null }): T | null {
  const last = useRef(value);
  const [, force] = useState(0);
  if (value != null) last.current = value;
  useEffect(() => {
    const el = sheet.current;
    if (value != null || last.current == null || !el) return;
    const clear = () => {
      if (last.current == null) return;
      last.current = null;
      force((n) => n + 1);
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === el && e.propertyName === 'transform') clear();
    };
    el.addEventListener('transitionend', onEnd);
    const timer = setTimeout(clear, SHEET_CLEAR_MS);
    return () => {
      el.removeEventListener('transitionend', onEnd);
      clearTimeout(timer);
    };
    // `sheet` is a stable ref; only opening and closing matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return value ?? last.current;
}

/** Small sheet listing a track's credited artists (from Now Playing). */
export function ArtistChooser() {
  const open = artistChoice.value;
  const sheet = useRef<HTMLDivElement>(null);
  const names = useSheetContent(open, sheet);
  const close = () => (artistChoice.value = null);
  return (
    <div class={'sheet-wrap' + (open ? ' open' : '')} aria-hidden={!open} inert={!open}>
      <div class="scrim" onClick={close} />
      <div class="sheet" ref={sheet} role="dialog" aria-modal="true" aria-label="Choose an artist" data-testid="artist-chooser">
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

// ---- Track ⋯ menu ------------------------------------------------------------------

export function TrackMenu() {
  const open = menuTrack.value;
  const sheet = useRef<HTMLDivElement>(null);
  const t = useSheetContent(open, sheet);
  void liked.value;
  const close = () => (menuTrack.value = null);
  const fav = t ? isLiked(t.id) : false;
  return (
    <div class={'sheet-wrap' + (open ? ' open' : '')} aria-hidden={!open} inert={!open}>
      <div class="scrim" onClick={close} />
      <div class="sheet" ref={sheet} role="dialog" aria-modal="true" aria-label="Track options" data-testid="track-menu">
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
              <Icon name="share" size={20} /> {canSharePost(t) ? 'Share track' : 'Share'}
            </button>
            {canSharePost(t) && (
              <button
                class="sheet-item"
                onClick={() => {
                  close();
                  void sharePost(t);
                }}
                data-testid="menu-share-post"
              >
                <Icon name="share" size={20} /> Share post
              </button>
            )}
            <button
              class="sheet-item"
              onClick={() => {
                toggleLikeWithUndo(t);
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
            {block.degraded.value && t.ytId && (
              <button
                class="sheet-item"
                onClick={() => {
                  openExternal(youtubeUrl(t.ytId));
                  close();
                }}
                data-testid="menu-open-youtube"
              >
                <Icon name="external" size={20} /> <span class="sheet-text">Open in YouTube</span>
              </button>
            )}
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
