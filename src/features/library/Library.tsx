import { computed, type ReadonlySignal } from '@preact/signals';
import { useCallback, useMemo, useRef } from 'preact/hooks';
import type { Track } from '../../data/model';
import { historyShown, likedShown, recentShown } from '../../stores/library';
import { dayKey, groupByDay } from '../../stores/history';
import { useChunks } from '../../ui/useChunks';
import { clearHistoryWithUndo } from '../../stores/undo';
import { Icon, type IconName } from '../../ui/icons';
import { BackButton } from '../../ui/components/BackButton';
import { EmptyState, PlayShuffle, Tracks } from '../../ui/components/TrackList';
import { playFrom } from '../../ui/playAll';
import { TrackRow } from '../../ui/components/TrackRow';
import { Screen } from '../../ui/components/Screen';
import { askConfirm, nowPlayingOpen, openLibraryPage, popToRoot, selectTab, useSearchContext } from '../../ui/nav';
import { list } from '../../ui/playAll';
import { afterPress } from '../../ui/press';
import { plural } from '../../core/text';

const LIKED_CTX = list('Liked');
const RECENT_CTX = list('Recently played');

/** Library → Liked, from anywhere (the offline line, at the top and in Now Playing, and the offline toast's button). */
export function openLiked(): void {
  nowPlayingOpen.value = false;
  popToRoot('library');
  selectTab('library');
  openLibraryPage('liked');
}

/** M3: clearing history asks first, and can still be undone from the toast. It counts what the tab counts. */
function confirmClear(): void {
  askConfirm({
    title: 'Clear listening history?',
    body: 'Everything under Recently played goes.',
    confirm: `Clear ${plural(recentShown.peek().length, 'track')}`,
    run: clearHistoryWithUndo,
  });
}

/** A row's count: only it follows its list (a play changes Recently played's). */
function Count({ of }: { of: ReadonlySignal<Track[]> }) {
  const n = of.value.length;
  return (
    <>
      <span class="count">{n}</span> {n === 1 ? 'song' : 'songs'}
    </>
  );
}

/** One of Library's lists: an outlined tile with its icon, its name and count, a chevron; a tap opens its page. */
function LibRow({ icon, title, of, onOpen, testid }: { icon: IconName; title: string; of: ReadonlySignal<Track[]>; onOpen: () => void; testid: string }) {
  return (
    <li class="row lib-row">
      <button class="row-main" onClick={(e) => afterPress(e.currentTarget, onOpen)} data-testid={testid}>
        <div class="row-art">
          <div class="lib-tile" aria-hidden="true">
            <Icon name={icon} size={24} />
          </div>
        </div>
        <div class="row-text">
          <div class="row-title">{title}</div>
          <div class="row-artist">
            <Count of={of} />
          </div>
        </div>
        <Icon name="chevron" size={16} class="lib-chev" />
      </button>
    </li>
  );
}

/** Liked and Recently played, each once, for Here search on Library's list. */
const libraryTracks = computed(() => {
  const seen = new Set<string>();
  return [...likedShown.value, ...recentShown.value].filter((t) => !seen.has(t.id) && (seen.add(t.id), true));
});

/** The Library tab: a list of its lists, each opening its own page. */
export function Library() {
  useSearchContext({ label: 'Library', tracks: () => libraryTracks.value });
  return (
    <Screen testid="screen-library" title="Library" subtitle="On this device" scrollKey="library">
      <ul class="list lib-list" aria-label="Library">
        <LibRow icon="heart" title="Liked" of={likedShown} onOpen={() => openLibraryPage('liked')} testid="lib-liked" />
        <LibRow icon="clock" title="Recently played" of={recentShown} onOpen={() => openLibraryPage('recent')} testid="lib-recent" />
      </ul>
    </Screen>
  );
}

/** Liked, its own page: Play and Shuffle, the songs. */
export function LikedPage() {
  const tracks = likedShown.value;
  useSearchContext({ label: 'Liked', tracks: () => likedShown.value });
  return (
    <Screen testid="screen-liked" title="Liked" subtitle="Library" left={<BackButton testid="liked-back" />} scrollKey="library:liked">
      {tracks.length > 0 && <PlayShuffle tracks={tracks} ctx={LIKED_CTX} testid="lib" playTestid="lib-play-all" />}
      <div data-testid="liked-list">
        {tracks.length ? (
          <Tracks tracks={tracks} ctx={LIKED_CTX} />
        ) : (
          <EmptyState title="No liked songs yet">
            Tap <Icon name="heartOutline" size={16} /> in the player, or Like in a track's ⋯ menu, to keep it here.
            <div>
              <button class="link-btn" onClick={(e) => afterPress(e.currentTarget, () => selectTab('home'))}>
                [Browse the Jukebox]
              </button>
            </div>
          </EmptyState>
        )}
      </div>
    </Screen>
  );
}

/** Recently played, its own page: by day, newest first; [Clear] in its top bar. */
export function RecentPage() {
  const tracks = recentShown.value;
  useSearchContext({ label: 'Recently played', tracks: () => recentShown.value });
  return (
    <Screen
      testid="screen-recent"
      title="Recently played"
      subtitle="Library"
      left={<BackButton testid="recent-back" />}
      scrollKey="library:recent"
      right={
        tracks.length > 0 ? (
          // Away from Play / Shuffle, so it can't be hit by accident.
          <button class="link-btn lib-clear" onClick={confirmClear} data-testid="lib-clear">
            [Clear]
          </button>
        ) : undefined
      }
    >
      {tracks.length > 0 && <PlayShuffle tracks={tracks} ctx={RECENT_CTX} testid="lib" playTestid="lib-play-all" />}
      <div data-testid="recent-list">{tracks.length ? <HistoryDays /> : <EmptyState title="Nothing played yet">Tracks you play show up here, newest first.</EmptyState>}</div>
    </Screen>
  );
}

/**
 * Recently played, grouped by day (Today, Yesterday, Mon 6 Oct), rendered in chunks as you
 * scroll. A track appears once per day; tapping one plays the whole history from there.
 */
function HistoryDays() {
  const entries = historyShown.value;
  const today = dayKey(Date.now());
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `today`: the labels change at midnight
  const days = useMemo(() => groupByDay(entries, Date.now()), [entries, today]);
  const all = useMemo(() => days.flatMap((d) => d.tracks), [days]);
  const { shown, sentinel, more } = useChunks(all.length, 'history');
  // Each play goes on top, so rows are numbered from the bottom: a new play leaves the
  // numbers (and so the memoised rows) of those already there alone, and onPlay is one
  // function for good (it reads the rows through a ref).
  const rows = useRef(all);
  rows.current = all;
  // The rows list a track once per day; what plays is the history with each track once (as
  // Play does), from the tapped one.
  const onPlay = useCallback((fromEnd: number) => {
    const list = recentShown.peek();
    const id = rows.current[rows.current.length - 1 - fromEnd]?.id;
    void playFrom(list, Math.max(0, list.findIndex((t) => t.id === id)), RECENT_CTX);
  }, []);
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
                <TrackRow key={t.id} track={t} index={all.length - 1 - (start + i)} onPlay={onPlay} />
              ))}
            </ul>
          </section>
        );
      })}
      {more ? <div ref={sentinel} class="list-foot" aria-hidden="true" /> : <div class="list-foot end">— end of tape —</div>}
    </>
  );
}
