import { useComputed } from '@preact/signals';
import { memo } from 'preact/compat';
import type { Track } from '../../data/model';
import { currentId, isPlaying, player } from '../../player';
import { Icon } from '../icons';
import { menuTrack, nowPlayingOpen } from '../nav';
import { Art } from './Art';

/** M9: a second tap on the same row this soon is the tail of a double tap. */
const ROW_DOUBLE_TAP_MS = 500;
/** P10: holding a row this long opens its ⋯ menu. */
const LONG_PRESS_MS = 500;
/** A finger that moves this far (px) is scrolling, not pressing. */
const PRESS_SLOP = 10;

let lastRowTap = { id: '', at: 0 };

/**
 * A tap on a row: ignored right after a tap on the same row; on the track that's
 * already current it resumes (paused) or opens Now Playing (playing), never restarts;
 * otherwise it plays.
 */
function tapRow(track: Track, play: () => void, now = performance.now()): void {
  if (lastRowTap.id === track.id && now - lastRowTap.at < ROW_DOUBLE_TAP_MS) return;
  lastRowTap = { id: track.id, at: now };
  if (currentId.peek() === track.id) {
    if (isPlaying.peek()) nowPlayingOpen.value = true;
    else void player.play();
    return;
  }
  play();
}

function buzz(): void {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(10);
  } catch {
    /* no haptics */
  }
}

/**
 * The click a browser makes when the finger lifts after a long press goes to whatever
 * is under it by then (the menu that just opened): swallow it, wherever it lands and
 * however long the finger stays down. The next touch (a new pointerdown) ends it, so a
 * release that makes no click doesn't eat a later tap.
 */
function swallowNextClick(): void {
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    off();
  };
  const off = () => {
    document.removeEventListener('click', stop, true);
    document.removeEventListener('pointerdown', off, true);
  };
  document.addEventListener('click', stop, true);
  document.addEventListener('pointerdown', off, true);
}

/** The press in progress (one finger, one row at a time). */
let press: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;

function cancelPress(): void {
  if (press) clearTimeout(press.timer);
  press = null;
}

function movedTooFar(x: number, y: number): boolean {
  return !!press && Math.hypot(x - press.x, y - press.y) > PRESS_SLOP;
}

/**
 * A press ends when the finger moves (pointer or touch events: during a pull-to-refresh
 * or a pan, Chrome may send only touch events) or anything scrolls. Passive, installed once.
 */
if (typeof document !== 'undefined') {
  const opts = { capture: true, passive: true } as const;
  document.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (!t || e.touches.length > 1 || movedTooFar(t.clientX, t.clientY)) cancelPress();
    },
    opts,
  );
  document.addEventListener('pointermove', (e) => movedTooFar(e.clientX, e.clientY) && cancelPress(), opts);
  document.addEventListener('scroll', cancelPress, opts);
}

/**
 * P10: long-press opens the row's ⋯ menu (with a short haptic tick), and the click that
 * ends the press is swallowed. Moving the finger (a scroll) cancels it. No re-renders.
 */
function longPress(track: Track) {
  return {
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      cancelPress();
      press = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          press = null;
          swallowNextClick();
          buzz();
          menuTrack.value = track;
        }, LONG_PRESS_MS),
      };
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onPointerLeave: cancelPress,
    onContextMenu: (e: Event) => e.preventDefault(),
  };
}

function Bars() {
  return (
    <span class="bars" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/** A members-only post (seen only when signed in with Cyberspace). */
export function MembersTag({ class: cls }: { class?: string }) {
  return (
    <span class={'mtag' + (cls ? ' ' + cls : '')} title="Members-only post" aria-label="Members-only post" data-testid="members-tag">
      [members]
    </span>
  );
}

/**
 * A track in a list. Memoised: a list re-rendering (a page loading more, a like) leaves its
 * rows alone unless their own props change, so `onPlay` must be one function per list.
 */
export const TrackRow = memo(function TrackRow({
  track,
  onPlay,
  index,
  hideGenre,
  showSaves,
}: {
  track: Track;
  /** Plays the list from row `index`. */
  onPlay: (index: number) => void;
  index: number;
  hideGenre?: boolean;
  /** Show the post's save count (Most saved). */
  showSaves?: boolean;
}) {
  // Only the row that becomes (or stops being) current re-renders on a track change,
  // and only the current row follows play/pause.
  const current = useComputed(() => currentId.value === track.id);
  const isCurrent = current.value;
  const press = longPress(track);
  return (
    <li class={'row' + (isCurrent ? ' is-current' : '')} data-testid="track-row" data-track-id={track.id}>
      <button
        class="row-main"
        {...press}
        onClick={() => tapRow(track, () => onPlay(index))}
        aria-label={`Play ${track.title} by ${track.artist}`}
        data-testid="track-play"
        data-index={index}
      >
        <div class="row-art">
          <Art track={track} size="sm" />
          {isCurrent && (
            <div class="row-art-badge">{isPlaying.value ? <Bars /> : <Icon name="pause" size={18} />}</div>
          )}
        </div>
        <div class="row-text">
          <div class="row-title" data-testid="track-title">
            {track.title}
          </div>
          <div class="row-artist">{track.artist}</div>
          <div class="row-meta">
            {showSaves && (
              <span class="saves" data-testid="track-saves" data-saves={track.saves ?? 0} aria-label={`${track.saves ?? 0} saves`}>
                <Icon name="bookmark" size={12} />
                {track.saves ?? 0}
              </span>
            )}
            {track.membersOnly && <MembersTag />}
            {track.genre && !hideGenre && <span class="tag">{track.genre}</span>}
            {track.by && <span class="by">by @{track.by}</span>}
          </div>
        </div>
      </button>
      <button
        class="icon-btn row-more"
        aria-label={`More options for ${track.title}`}
        aria-haspopup="dialog"
        data-testid="track-more"
        onClick={() => (menuTrack.value = track)}
      >
        <Icon name="more" />
      </button>
    </li>
  );
});

export function SkeletonRows({ n = 8 }: { n?: number }) {
  return (
    <ul class="list" aria-hidden="true" data-testid="skeleton">
      {Array.from({ length: n }, (_, i) => (
        <li class="row skel" key={i}>
          <div class="row-main">
            <div class="row-art">
              <div class="art art-sm skel-block" />
            </div>
            <div class="row-text">
              <div class="skel-line" style={{ width: `${55 + ((i * 37) % 35)}%` }} />
              <div class="skel-line dim" style={{ width: `${30 + ((i * 23) % 30)}%` }} />
              <div class="skel-line dim short" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
