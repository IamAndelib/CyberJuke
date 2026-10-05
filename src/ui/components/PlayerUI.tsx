import { useEffect, useState } from 'preact/hooks';
import { player, livePosition, type PlayerState } from '../../player';
import { isLiked, liked, toggleLike } from '../../store/library';
import { toast, toasts } from '../../store/toast';
import { Icon } from '../icons';
import { menuTrack, nowPlayingOpen, openPost } from '../nav';
import { Art } from './Art';

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

  return (
    <div
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

          <div class="np-art dos">
            <div class="dos-frame">
              <Art track={t} size="fill" />
            </div>
            <div class="dos-shadow" aria-hidden="true" />
          </div>

          <div class="np-meta">
            <div class="np-titles">
              <h2 class="np-title" data-testid="np-title">
                {t.title}
              </h2>
              <div class="np-artist">{t.artist}</div>
              {t.genre && <span class="tag">{t.genre}</span>}
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

          {t.by && (
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
        <div class="dim small upnext-empty">{s.repeat === 'all' ? 'Queue repeats from the top.' : 'Nothing queued. Add tracks with ⋯ → Add to queue.'}</div>
      ) : (
        <ol class="list compact">
          {items.map(({ track, index }, k) => (
            <li class="row" key={`${track.id}:${index}`} data-testid="upnext-row">
              <button class="row-main" onClick={() => player.skipTo(index)} aria-label={`Play ${track.title}`}>
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
                void player.playNext([t]);
                toast('Playing next');
                close();
              }}
              data-testid="menu-play-next"
            >
              <Icon name="playNext" size={20} /> Play next
            </button>
            <button
              class="sheet-item"
              onClick={() => {
                void player.addToQueue([t]);
                toast('Added to queue');
                close();
              }}
              data-testid="menu-add-queue"
            >
              <Icon name="plus" size={20} /> Add to queue
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
            <button
              class="sheet-item"
              onClick={() => {
                openPost(t.postUrl);
                close();
              }}
              data-testid="menu-open-post"
            >
              <Icon name="external" size={20} /> Open post{t.by ? ` by @${t.by}` : ''}
            </button>
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
