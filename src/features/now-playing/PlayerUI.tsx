import { effect } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  canSkipNext,
  currentId,
  currentTrack,
  durationMs,
  hasCurrent,
  isAdvancing,
  isBuffering,
  isPlaying,
  livePosition,
  playContext,
  player,
  positionSample,
  queuePlace,
  repeatMode,
  shuffleOn,
  upNextSections,
} from '../../player';
import { block } from '../../stores/block';
import { toggleLikeWithUndo } from '../../stores/undo';
import { toast } from '../../stores/toast';
import { Icon } from '../../ui/icons';
import { artistChoice, lyricsOpen, menuTrack, nowPlayingOpen, openArtistPage, openGenrePage } from '../../ui/nav';
import { openExternal, openPost, youtubeUrl } from '../../ui/links';
import { positionNow, useTickValue } from '../../ui/useTick';
import { splitArtists } from '../../data/artists';
import { isGlobal, type Track } from '../../data/model';
import { reducedMotion } from '../../core/motion';
import { Art } from '../../ui/components/Art';
import { Marquee } from './Marquee';
import { MembersTag } from '../../ui/components/TrackRow';
import { LyricsPanel } from './Lyrics';
import { UpNext } from './UpNext';
import { useModal, useSheetContent } from '../../ui/useModal';
import { useLiked } from '../../ui/useFavs';
import { shareTrack } from '../../ui/share';

function fmt(ms: number): string {
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
 * The thin progress line. On each position sample (about once a second) the fill's scaleX is
 * set, and while playing an animation carries it on to the end of the track: the compositor
 * moves it, so playback re-renders nothing and runs no script between samples.
 */
function MiniProgress() {
  const fill = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let run: Animation | null = null;
    const stop = effect(() => {
      const s = positionSample.value;
      const el = fill.current;
      if (!el) return;
      const pos = livePosition({ ...player.state.peek(), ...s });
      const dur = s.durationMs;
      const f = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0;
      el.style.transform = `scaleX(${f.toFixed(4)})`;
      run?.cancel();
      run = null;
      if (s.isPlaying && !s.isBuffering && dur > pos && typeof el.animate === 'function') {
        run = el.animate([{ transform: `scaleX(${f})` }, { transform: 'scaleX(1)' }], { duration: dur - pos, easing: 'linear' });
      }
    });
    return () => {
      stop();
      run?.cancel();
    };
  }, []);
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
const MINI_SWIPE_PX = 32;

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

/** The ♥ beside the title: only it re-renders when Liked changes. */
function NpLike({ track }: { track: Track }) {
  const fav = useLiked(track.id);
  return (
    <button
      class={'icon-btn like' + (fav ? ' on' : '')}
      aria-pressed={fav}
      aria-label={fav ? 'Remove from liked' : 'Like'}
      onClick={() => toggleLikeWithUndo(track)}
      data-testid="np-like"
    >
      <Icon name={fav ? 'heart' : 'heartOutline'} size={28} />
    </button>
  );
}

/** A drag on the seek bar: where the thumb is, for which track. */
interface SeekDrag {
  id: string | undefined;
  ms: number;
}

/** The thumb's full width (14px + 2 × 3px border, now-playing.css): its centre travels the bar less this. */
const SEEK_THUMB_PX = 20;
/** A finger moving this far decides: sideways is a seek drag, up or down is a scroll. */
const SEEK_SLOP_PX = 8;

/** A pointer on the bar: where it went down, on which track, and whether it is dragging the thumb yet. */
interface SeekPointer {
  id: number;
  x0: number;
  y0: number;
  track: string | undefined;
  dragging: boolean;
}

function SeekBar() {
  // Re-renders once a second while playing (the time shown), and on a seek: not every frame.
  useTickValue(isAdvancing.value, () => Math.floor(positionNow() / 1000));
  const live = positionNow();
  const [drag, setDrag] = useState<SeekDrag | null>(null);
  // The drag in progress, read by whichever event ends it first.
  const dragRef = useRef<SeekDrag | null>(null);
  const pointer = useRef<SeekPointer | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = currentId.value ?? undefined;
  const dur = durationMs.value;
  // A drag left over from another track (it changed mid-drag) shows nothing.
  const pos = drag && drag.id === id ? drag.ms : live;
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  /** The thumb at `ms`, for the track the gesture began on (the keyboard: the current one). */
  const move = (ms: number, track = id) => {
    dragRef.current = { id: track, ms };
    setDrag(dragRef.current);
  };
  const capture = (el: HTMLElement, pointerId: number) => {
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // Not a live pointer (one an accessibility service made up): nothing to capture.
    }
  };
  /** The drag ends: one seek, on the track it was made on. */
  const end = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (d && d.id === player.state.peek().current?.id) void player.seek(d.ms);
  };
  /** Where a pointer at `x` puts the thumb (its centre over the bar less the thumb), in ms. */
  const msAt = (x: number) => {
    const el = input.current;
    const d = player.state.peek().durationMs;
    if (!el || d <= 0) return 0;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (x - r.left - SEEK_THUMB_PX / 2) / Math.max(1, r.width - SEEK_THUMB_PX)));
    return Math.round((f * d) / 1000) * 1000;
  };

  // The keyboard (and TalkBack) work the range itself: each step moves the thumb (input),
  // and `change` ends it with one seek. Listened to natively: preact/compat (loaded for memo)
  // turns onChange on inputs into onInput.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.addEventListener('change', end);
    return () => el.removeEventListener('change', end);
  }, []);

  // A finger or the mouse on the bar (the range itself takes no pointer: Chromium would put
  // the thumb under the finger at once, before knowing whether the finger means to scroll).
  // A finger decides by its first moves: sideways drags the thumb, up or down scrolls Now
  // Playing (touch-action: pan-y; the browser then cancels the pointer) and changes nothing.
  // A tap seeks to that spot. The mouse drags from the press, like any slider.
  // One finger at a time, any finger (a thumb may be resting elsewhere on the screen). A
  // pointer event aimed at the range itself is no real one (it takes no pointer): an
  // accessibility service's, which works the range as a slider.
  const onPointerDown = (e: PointerEvent) => {
    if (pointer.current || e.target === input.current || (e.pointerType === 'mouse' && e.button !== 0) || dur <= 0) return;
    const p: SeekPointer = { id: e.pointerId, x0: e.clientX, y0: e.clientY, track: id, dragging: false };
    pointer.current = p;
    if (e.pointerType === 'mouse') {
      // No mousedown focus handling: it would move focus off the range to the bar's box.
      e.preventDefault();
      p.dragging = true;
      capture(e.currentTarget as HTMLElement, e.pointerId);
      input.current?.focus({ preventScroll: true });
      move(msAt(e.clientX), p.track);
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    const p = pointer.current;
    if (!p || e.pointerId !== p.id) return;
    if (!p.dragging) {
      const dx = Math.abs(e.clientX - p.x0);
      const dy = Math.abs(e.clientY - p.y0);
      if (dy > SEEK_SLOP_PX && dy > dx) {
        pointer.current = null; // a scroll: not ours
        return;
      }
      if (dx <= SEEK_SLOP_PX) return;
      p.dragging = true;
      capture(e.currentTarget as HTMLElement, e.pointerId);
    }
    move(msAt(e.clientX), p.track);
  };
  const onPointerUp = (e: PointerEvent) => {
    const p = pointer.current;
    if (!p || e.pointerId !== p.id) return;
    pointer.current = null;
    // A tap (never past the slop): the thumb goes there.
    if (!p.dragging) move(msAt(e.clientX), p.track);
    end();
  };
  const onPointerCancel = (e: PointerEvent) => {
    const p = pointer.current;
    if (!p || e.pointerId !== p.id) return;
    pointer.current = null;
    // The browser took the finger (a scroll): nothing was moved unless it was dragging.
    if (p.dragging) {
      dragRef.current = null;
      setDrag(null);
    }
  };

  return (
    <div class="seek">
      <div class="seek-hit" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
        <input
          ref={input}
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
          onInput={(e) => move(Number((e.target as HTMLInputElement).value))}
          data-testid="seek"
        />
      </div>
      <div class="seek-times">
        <span data-testid="time-pos">{fmt(pos)}</span>
        <span data-testid="time-dur">{dur > 0 ? fmt(dur) : '--:--'}</span>
      </div>
    </div>
  );
}

/** Close when dragged this share of the sheet's height, or flicked faster than this. */
const SWIPE_CLOSE_FRACTION = 0.25;
const SWIPE_CLOSE_VELOCITY = 0.5; // px/ms

/**
 * Let go to close, the sheet carries on from the finger: a fast start that eases out, timed
 * so its first frames move at the finger's speed (the curve starts at about 2.4 × its average
 * speed), at least EXIT_MIN_SPEED, within EXIT_MIN_MS..EXIT_MAX_MS.
 */
const EXIT_EASE = 'cubic-bezier(0.25, 0.6, 0.45, 1)';
const EXIT_START_SLOPE = 2.4;
const EXIT_MIN_SPEED = 1.2; // px/ms
const EXIT_MIN_MS = 120;
const EXIT_MAX_MS = 240;

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
      const h = el.clientHeight || 1;
      const close = dy > h * SWIPE_CLOSE_FRACTION || v > SWIPE_CLOSE_VELOCITY;
      if (!close) return reset();
      if (reducedMotion()) {
        el.style.transition = 'none';
        el.style.transform = '';
        el.style.opacity = '';
        nowPlayingOpen.value = false;
        requestAnimationFrame(() => (el.style.transition = ''));
        return;
      }
      // On from where the finger let go, in one motion, at its speed: the end state is set
      // here (the class change that follows can't send it back up or restart it slowly), and
      // the sheet keeps its layer until it is down.
      const ms = Math.round(Math.min(EXIT_MAX_MS, Math.max(EXIT_MIN_MS, ((h - dy) / Math.max(v, EXIT_MIN_SPEED)) * EXIT_START_SLOPE)));
      el.style.willChange = 'transform, opacity';
      el.style.transition = `transform ${ms}ms ${EXIT_EASE}, opacity ${ms}ms linear, visibility 0s linear ${ms}ms`;
      el.style.transform = 'translateY(100%)';
      el.style.opacity = '0.6';
      nowPlayingOpen.value = false;
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        el.removeEventListener('transitionend', onDone);
        clearTimeout(timer);
        unwatch();
        // The closed class holds the same values: nothing moves.
        el.style.transition = '';
        el.style.transform = '';
        el.style.opacity = '';
        el.style.willChange = '';
      };
      const onDone = (ev: TransitionEvent) => {
        if (ev.target === el && ev.propertyName === 'transform') settle();
      };
      el.addEventListener('transitionend', onDone);
      // Only if no transitionend comes (a hidden page): cleared mid-flight, the class's own
      // transition would restart the motion.
      const timer = setTimeout(settle, ms + 1000);
      // Opened again on its way down: the opening takes over from where it is.
      const unwatch = nowPlayingOpen.subscribe((open) => open && settle());
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
    // Mount-only: `ref` is a stable ref object to the sheet, which never remounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const NEXT_REPEAT = { off: 'all', all: 'one', one: 'off' } as const;
const REPEAT_LABEL = { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' } as const;

/** How long the sheet's contents stay after closing: the slide-down (0.2s) plus a margin. */
const NP_UNMOUNT_MS = 400;

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
  // Focus goes in when it opens and back to what opened it (the app behind is made inert
  // by App once the slide-in ends).
  useModal(open, sheet, { inertBehind: false });

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

/** The sheet's contents. Reads only the track and the lyrics toggle: the clock re-renders the seek bar alone. */
function NowPlayingContent() {
  const t = currentTrack.value;
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
              <NpFrom />
            </div>
            <button class="icon-btn" onClick={() => (menuTrack.value = t)} aria-label="More options" data-testid="np-more">
              <Icon name="more" />
            </button>
          </header>

          <div class={'np-art dos' + (showLyrics ? ' lyrics' : '')}>
            <div class="dos-frame">
              {showLyrics ? (
                <LyricsPanel track={t} />
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
            {/* Title and artist as one block, the heart centred beside both (it never sits on the scrolling title). */}
            <div class="np-id">
              <div class="np-titles">
                <h2 class="np-title" data-testid="np-title">
                  <Marquee text={t.title} />
                </h2>
                <NpArtist track={t} />
              </div>
              <NpLike track={t} />
            </div>
            {(t.membersOnly || t.genre) && (
              <div class="np-tags">
                {t.membersOnly && <MembersTag class="np-members" />}
                {t.genre && (
                  <button class="tag np-genre" onClick={() => openGenrePage(t.genre)} aria-label={`Open genre ${t.genre}`} data-testid="np-genre">
                    <span class="np-genre-text">{t.genre}</span>
                  </button>
                )}
              </div>
            )}
          </div>

          <SeekBar />
          <NpControls />

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

          <UpNext />
        </div>
      )}
    </>
  );
}

/** Shuffle, Previous, Play/Pause, Next, Repeat. */
function NpControls() {
  const shuffle = shuffleOn.value;
  const repeat = repeatMode.value;
  return (
    <div class="np-controls">
      <button
        class={'icon-btn toggle-icon' + (shuffle ? ' on' : '')}
        aria-pressed={shuffle}
        aria-label={shuffle ? 'Shuffle on' : 'Shuffle off'}
        onClick={() => player.setShuffle(!shuffle)}
        data-testid="np-shuffle"
      >
        <Icon name="shuffle" />
      </button>
      <button class="icon-btn big" aria-label="Previous track" onClick={() => player.prev()} data-testid="np-prev">
        <Icon name="prev" size={36} />
      </button>
      <button class="play-btn" aria-label={isPlaying.value ? 'Pause' : 'Play'} onClick={() => player.toggle()} data-testid="np-toggle">
        <PlayPauseIcon size={40} />
      </button>
      <NextButton size={36} class="icon-btn big" testid="np-next" />
      <button
        class={'icon-btn toggle-icon' + (repeat !== 'off' ? ' on' : '')}
        aria-pressed={repeat !== 'off'}
        aria-label={REPEAT_LABEL[repeat]}
        onClick={() => player.setRepeat(NEXT_REPEAT[repeat])}
        data-testid="np-repeat"
        data-mode={repeat}
      >
        <Icon name={repeat === 'one' ? 'repeatOne' : 'repeat'} />
      </button>
    </div>
  );
}

/**
 * Under "Now playing": where the music comes from (P8), "Playing from Home · Latest",
 * or "Radio · <seed>" for a radio. Without shuffle the position ("3 of 50") comes
 * first; under shuffle the position means little, so only the source shows.
 */
function NpFrom() {
  const ctx = playContext.value;
  const seed = upNextSections.value.seed;
  const from = !ctx?.label ? '' : ctx.mode === 'radio' ? `Radio · ${seed?.title || ctx.label}` : `Playing from ${ctx.label}`;
  const pos = queuePlace.value;
  const text = shuffleOn.value && from ? from : from ? `${pos} · ${from}` : pos;
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

/** Small sheet listing a track's credited artists (from Now Playing). */
export function ArtistChooser() {
  const open = artistChoice.value;
  const sheet = useRef<HTMLDivElement>(null);
  const names = useSheetContent(open, sheet);
  useModal(open != null, sheet);
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
  useModal(open != null, sheet);
  const close = () => (menuTrack.value = null);
  const fav = useLiked(t?.id);
  // A track still being looked up (no video yet) can't be queued, shared or liked.
  const known = !!t?.ytId;
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
              disabled={!known}
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
              disabled={!known}
              data-testid="menu-share"
            >
              <Icon name="share" size={20} /> Share
            </button>
            <button
              class="sheet-item"
              onClick={() => {
                toggleLikeWithUndo(t);
                close();
              }}
              disabled={!known}
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
