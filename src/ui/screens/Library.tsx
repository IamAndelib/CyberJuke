import { signal } from '@preact/signals';
import { history, liked, recent } from '../../stores/library';
import { groupByDay } from '../../stores/history';
import { clearHistoryWithUndo } from '../../stores/undo';
import { Icon } from '../icons';
import { EmptyState, PlayShuffle, Tracks, playFrom } from '../components/TrackList';
import { TrackRow } from '../components/TrackRow';
import { Screen } from '../components/Screen';
import { askConfirm, selectTab, useSearchContext } from '../nav';
import { list } from '../playAll';

const section = signal<'liked' | 'recent'>('liked');

const LIKED_CTX = list('Liked');
const RECENT_CTX = list('Recently played');

/** M3: clearing history asks first, and can still be undone from the toast. */
function confirmClear(): void {
  const n = history.value.length;
  askConfirm({
    title: 'Clear listening history?',
    body: 'Everything under Recently played goes.',
    confirm: `Clear ${n} play${n === 1 ? '' : 's'}`,
    run: clearHistoryWithUndo,
    testid: 'confirm-clear',
  });
}

export function Library() {
  const sel = section.value;
  const tracks = sel === 'liked' ? liked.value : recent.value;
  const ctx = sel === 'liked' ? LIKED_CTX : RECENT_CTX;
  useSearchContext(sel === 'liked' ? { label: 'Liked', tracks: () => liked.value } : { label: 'Recently played', tracks: () => recent.value });
  return (
    <Screen
      testid="screen-library"
      title="Library"
      subtitle="On this device"
      scrollKey={`library:${sel}`}
      right={
        sel === 'recent' && tracks.length > 0 ? (
          // Away from Play / Shuffle, so it can't be hit by accident.
          <button class="link-btn lib-clear" onClick={confirmClear} data-testid="lib-clear">
            [Clear]
          </button>
        ) : undefined
      }
    >
      <div class="segmented" role="tablist" aria-label="Library section">
        <button
          role="tab"
          aria-selected={sel === 'liked'}
          class={sel === 'liked' ? 'on' : ''}
          onClick={() => (section.value = 'liked')}
          data-testid="lib-liked"
        >
          Liked <span class="count">{liked.value.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={sel === 'recent'}
          class={sel === 'recent' ? 'on' : ''}
          onClick={() => (section.value = 'recent')}
          data-testid="lib-recent"
        >
          Recently played <span class="count">{recent.value.length}</span>
        </button>
      </div>

      {tracks.length > 0 && <PlayShuffle tracks={tracks} ctx={ctx} testid="lib" playTestid="lib-play-all" />}

      <div data-testid={sel === 'liked' ? 'liked-list' : 'recent-list'}>
        {tracks.length ? (
          sel === 'liked' ? <Tracks tracks={tracks} ctx={LIKED_CTX} /> : <HistoryDays />
        ) : sel === 'liked' ? (
          <EmptyState title="No liked tracks yet">
            Tap <Icon name="heartOutline" size={16} /> in the player, or Like in a track's ⋯ menu, to keep it here.
            <div>
              <button class="link-btn" onClick={() => selectTab('home')}>
                [Browse the Jukebox]
              </button>
            </div>
          </EmptyState>
        ) : (
          <EmptyState title="Nothing played yet">Tracks you play show up here, newest first.</EmptyState>
        )}
      </div>
    </Screen>
  );
}

/**
 * Recently played, grouped by day (Today, Yesterday, Mon 6 Oct). A track appears once
 * per day; tapping one plays the whole history from there.
 */
function HistoryDays() {
  const days = groupByDay(history.value, Date.now());
  const all = days.flatMap((d) => d.tracks);
  let offset = 0;
  return (
    <>
      {days.map((d) => {
        const start = offset;
        offset += d.tracks.length;
        return (
          <section key={d.key} class="day-group" data-testid="history-day" data-day={d.key}>
            <h3 class="day-head" data-testid="history-day-label">
              <span>{d.label}</span>
              <span class="day-count">{d.tracks.length}</span>
            </h3>
            <ul class="list" data-testid="track-list">
              {d.tracks.map((t, i) => (
                <TrackRow key={t.id} track={t} index={start + i} onPlay={() => void playFrom(all, start + i, RECENT_CTX)} />
              ))}
            </ul>
          </section>
        );
      })}
      <div class="list-foot end">— end of tape —</div>
    </>
  );
}
