import { signal, type ReadonlySignal } from '@preact/signals';
import { useCallback, useMemo } from 'preact/hooks';
import type { Track } from '../../data/model';
import { history, liked, recent } from '../../stores/library';
import { dayKey, groupByDay } from '../../stores/history';
import { useChunks } from '../../ui/useChunks';
import { clearHistoryWithUndo } from '../../stores/undo';
import { Icon } from '../../ui/icons';
import { EmptyState, PlayShuffle, Tracks, playFrom } from '../../ui/components/TrackList';
import { TrackRow } from '../../ui/components/TrackRow';
import { Screen } from '../../ui/components/Screen';
import { askConfirm, selectTab, useSearchContext } from '../../ui/nav';
import { list } from '../../ui/playAll';

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

/** A tab's count: only it follows the list (a play changes Recently played's). */
function Count({ of }: { of: ReadonlySignal<Track[]> }) {
  return <span class="count">{of.value.length}</span>;
}

/** The Library tab. Reads only the list shown: a track change re-renders nothing here on Liked. */
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
          Liked <Count of={liked} />
        </button>
        <button
          role="tab"
          aria-selected={sel === 'recent'}
          class={sel === 'recent' ? 'on' : ''}
          onClick={() => (section.value = 'recent')}
          data-testid="lib-recent"
        >
          Recently played <Count of={recent} />
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
 * Recently played, grouped by day (Today, Yesterday, Mon 6 Oct), rendered in chunks as you
 * scroll. A track appears once per day; tapping one plays the whole history from there.
 */
function HistoryDays() {
  const entries = history.value;
  const today = dayKey(Date.now());
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `today`: the labels change at midnight
  const days = useMemo(() => groupByDay(entries, Date.now()), [entries, today]);
  const all = useMemo(() => days.flatMap((d) => d.tracks), [days]);
  const { shown, sentinel, more } = useChunks(all.length, 'history');
  const onPlay = useCallback((i: number) => void playFrom(all, i, RECENT_CTX), [all]);
  let offset = 0;
  return (
    <>
      {days.map((d) => {
        const start = offset;
        offset += d.tracks.length;
        if (start >= shown) return null;
        return (
          <section key={d.key} class="day-group" data-testid="history-day" data-day={d.key}>
            <h3 class="day-head" data-testid="history-day-label">
              <span>{d.label}</span>
              <span class="day-count">{d.tracks.length}</span>
            </h3>
            <ul class="list" data-testid="track-list">
              {d.tracks.slice(0, shown - start).map((t, i) => (
                <TrackRow key={t.id} track={t} index={start + i} onPlay={onPlay} />
              ))}
            </ul>
          </section>
        );
      })}
      {more ? <div ref={sentinel} class="list-foot" aria-hidden="true" /> : <div class="list-foot end">— end of tape —</div>}
    </>
  );
}
