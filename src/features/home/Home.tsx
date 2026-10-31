import { signal } from '@preact/signals';
import { useMemo, useState } from 'preact/hooks';
import { source } from '../../data';
import type { Track } from '../../data/model';
import { shuffled } from '../../core/shuffle';
import { isOffline } from '../../core/errors';
import { OFFLINE } from '../../core/offlineText';
import { catalog, mostSaved, type SavedRange } from '../../stores/catalog';
import { catalogGenre, chipGenres } from '../../stores/genres';
import { favoriteGenres, showNsfw } from '../../stores/library';
import { toast } from '../../stores/toast';
import { updateAvailable } from '../../stores/updates';
import { Icon } from '../../ui/icons';
import { CatalogError, EmptyState, PagedTracks, Tracks } from '../../ui/components/TrackList';
import { OfflineGate, useSeenOnline } from '../../ui/components/OfflineGate';
import { online } from '../../core/network';
import { savedLiked } from '../../stores/savedOffline';
import { SkeletonRows } from '../../ui/components/TrackRow';
import { Screen } from '../../ui/components/Screen';
import { openSettings } from '../../ui/nav';
import { afterPress } from '../../ui/press';
import { refreshCatalog } from '../../ui/refresh';
import { NewTracksPill } from './NewTracksPill';
import { Rail, RailRow, type RailItem } from '../../ui/components/Rail';
import { usePaged } from '../../ui/usePaged';
import { feedKey } from '../../stores/feed';
import { auth } from '../../data/auth';
import { canStartPlayback, shuffleLabel } from '../../player';
import { list as listCtx, playAll, radio, withRest } from '../../ui/playAll';

/** Selected genre chip on Home (null = All). Survives tab switches. */
const homeGenre = signal<string | null>(null);
/** Home sort: newest posts (Firestore pages) or most saved (local catalog). */
const homeSort = signal<'latest' | 'saved'>('latest');
const savedRange = signal<SavedRange>('month');

/** Most-saved list length; beyond this it's mostly single-save noise. */
const SAVED_MAX = 100;
const SAVED_CTX = radio('Most saved');

/** How many random songs Shuffle starts with. */
const SHUFFLE_SIZE = 50;

/**
 * SHUFFLE_SIZE random songs from the whole Jukebox or the chip's genre; autoplay goes on drawing
 * from the same (shuffleLabel). Already random, they play in that order: the Shuffle button stays
 * off, so the next album you play isn't shuffled too.
 */
async function shuffleJukebox(genre: string | null): Promise<void> {
  const all = genre ? catalogGenre(genre) : catalog.tracks.value;
  const tracks = all.length ? shuffled(all).slice(0, SHUFFLE_SIZE) : genre ? shuffled((await source.byGenre(genre)).tracks) : await source.shuffle(SHUFFLE_SIZE);
  if (!tracks.length) throw new Error('No tracks found');
  await playAll(tracks, { shuffle: false, ctx: listCtx(shuffleLabel(genre)) });
}

/** Offline, the liked songs saved on the phone, shuffled: what plays (Liked's own list). */
const LIKED_CTX = listCtx('Liked');

function ShuffleHero() {
  const [busy, setBusy] = useState(false);
  const genre = homeGenre.value;
  // Offline with liked songs saved, the hero shuffles them: Home always leads to music.
  const liked = !online.value && savedLiked.value.length > 0;
  const go = async () => {
    // The liked songs are saved: no connection needed (canStartPlayback would refuse it).
    if (busy || (!liked && !canStartPlayback())) return;
    setBusy(true);
    try {
      if (liked) await playAll(shuffled(savedLiked.peek()), { shuffle: false, ctx: LIKED_CTX });
      else await shuffleJukebox(genre);
    } catch (e) {
      toast(isOffline(e) ? OFFLINE.tap : "Couldn't shuffle right now");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="dos">
      <button class="hero dos-frame" onClick={go} data-testid="shuffle-all" aria-busy={busy}>
        <span class="hero-text">
          <span class="hero-kicker">{liked ? OFFLINE.heroKicker : 'Feeling lucky?'}</span>
          <span class="hero-title">{liked ? OFFLINE.heroLiked : genre ? `Shuffle ${genre}` : 'Shuffle the Jukebox'}</span>
          <span class="hero-sub">{busy ? 'Spinning the reels…' : liked ? OFFLINE.heroLikedSub : `Random picks from ${genre ?? 'the whole Jukebox'}`}</span>
        </span>
        <span class="hero-btn" aria-hidden="true">
          {busy ? <span class="spinner big" /> : <Icon name="shuffle" size={32} />}
        </span>
      </button>
      <div class="dos-shadow" aria-hidden="true" />
    </div>
  );
}

function GenreChips() {
  void favoriteGenres.value;
  const sel = homeGenre.value;
  const names = chipGenres(24);
  // Keep a selected genre visible even if it's not in the top slice.
  if (sel && !names.includes(sel)) names.unshift(sel);
  // P12: a row of toggles (aria-pressed), not tabs: tapping the selected one clears it.
  return (
    <div class="chips" role="group" aria-label="Filter by genre" data-testid="genre-chips">
      <button
        class={'chip' + (sel == null ? ' on' : '')}
        aria-pressed={sel == null}
        onClick={() => (homeGenre.value = null)}
        data-testid="chip-all"
      >
        All
      </button>
      {names.map((name) => (
        <button
          key={name}
          class={'chip' + (sel === name ? ' on' : '')}
          aria-pressed={sel === name}
          onClick={() => (homeGenre.value = sel === name ? null : name)}
          data-testid="genre-chip"
          data-genre={name}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

const SORTS: RailItem<'latest' | 'saved'>[] = [
  { id: 'latest', label: 'Latest', testid: 'sort-latest' },
  { id: 'saved', label: 'Most saved', testid: 'sort-saved' },
];
const RANGES: RailItem<SavedRange>[] = [
  { id: 'month', label: 'this month', testid: 'range-month' },
  { id: 'all', label: 'all time', testid: 'range-all' },
];

/** Latest | Most saved on the shared Rail; under Most saved, its range as a filter rail. */
function SortRail() {
  const sort = homeSort.value;
  return (
    <>
      <RailRow ruled class="home-rail" testid="home-rail">
        <Rail items={SORTS} value={sort} onChange={(v) => (homeSort.value = v)} label="Sort" testid="home-sort" />
      </RailRow>
      {sort === 'saved' && (
        <RailRow class="range-rail">
          <Rail
            items={RANGES}
            value={savedRange.value}
            onChange={(v) => (savedRange.value = v)}
            kind="radio"
            variant="filter"
            label="Time range"
            testid="saved-range"
          />
        </RailRow>
      )}
    </>
  );
}

function MostSaved({ genre }: { genre: string | null }) {
  const status = catalog.status.value;
  const all = catalog.tracks.value;
  const range = savedRange.value;
  const list = useMemo(() => mostSaved(all, { genre, range }).slice(0, SAVED_MAX), [all, genre, range]);
  if (!all.length) {
    if (status === 'error') {
      return <CatalogError />;
    }
    return <SkeletonRows />;
  }
  if (!list.length) {
    return (
      <EmptyState title={range === 'month' ? 'No saves this month yet' : 'No saved tracks yet'}>
        {range === 'month' ? (
          <button class="link-btn" onClick={() => (savedRange.value = 'all')}>
            [Show all time]
          </button>
        ) : (
          'Saves come from bookmarks on Cyberspace.'
        )}
      </EmptyState>
    );
  }
  return (
    <div data-testid="saved-list">
      <Tracks tracks={list} ctx={SAVED_CTX} showSaves hideGenre={genre != null} />
      <div class="list-foot end">— {list.length === SAVED_MAX ? `top ${SAVED_MAX}` : 'end of tape'} —</div>
    </div>
  );
}

/**
 * Latest or Most saved. Opened offline, Latest is the Jukebox saved on the phone from before
 * (newest first, the chip's genre): its saved liked songs play and the rest are dimmed, as a
 * list that loses the connection keeps its rows. With nothing saved, the offline state.
 */
function LatestOrSaved({ sort, genre, paged, queue, chunkKey }: { sort: 'latest' | 'saved'; genre: string | null; paged: ReturnType<typeof usePaged>; queue: () => Track[]; chunkKey: string }) {
  const seen = useSeenOnline();
  const ctx = radio(genre == null ? 'Home · Latest' : `Home · ${genre}`);
  // Most saved is the stored Jukebox already.
  if (sort === 'saved')
    return (
      <OfflineGate seen={seen || catalog.tracks.value.length > 0}>
        <MostSaved genre={genre} />
      </OfflineGate>
    );
  const stored = genre == null ? catalog.tracks.value : catalogGenre(genre);
  if (!seen && stored.length) return <Tracks tracks={stored} ctx={ctx} chunkKey={chunkKey} />;
  return (
    <OfflineGate seen={seen}>
      <PagedTracks paged={paged} ctx={ctx} queue={queue} chunkKey={chunkKey} />
    </OfflineGate>
  );
}

export function Home() {
  const g = homeGenre.value;
  const sort = homeSort.value;
  const nsfw = showNsfw.value;
  // Latest stays loaded while Most saved is shown, so switching back is instant.
  const key = feedKey.home(auth.state.value.status === 'signedIn', g, nsfw);
  const paged = usePaged(key, (c) => (g == null ? source.latest(c) : source.byGenre(g, c)));
  // P2: a tap plays from the whole list (the cached catalog), not only the loaded pages.
  const queue = () => withRest(paged.tracks, g == null ? catalog.tracks.value : catalogGenre(g));
  return (
    <Screen
      testid="screen-home"
      title={<span class="brand">CYBERJUKE</span>}
      subtitle="The Cyberspace Jukebox"
      right={<SettingsButton />}
      scrollKey={`home:${sort}:${sort === 'saved' ? savedRange.value : ''}:${g ?? ''}`}
      onRefresh={async () => {
        if (sort === 'saved') await refreshCatalog();
        else await paged.refresh();
      }}
    >
      <NewTracksPill
        toLatest={() => {
          homeSort.value = 'latest';
          homeGenre.value = null;
        }}
      />
      <ShuffleHero />
      <GenreChips />
      <SortRail />
      <LatestOrSaved sort={sort} genre={g} paged={paged} queue={queue} chunkKey={key} />
    </Screen>
  );
}

/** Settings, top right on Home; a dot when a newer release is out (stores/updates). */
function SettingsButton() {
  const update = updateAvailable.value;
  return (
    <button
      class="icon-btn settings-btn"
      aria-label={update ? 'Settings (update available)' : 'Settings'}
      // Settings replaces Home: its press shows first.
      onClick={(e) => afterPress(e.currentTarget, openSettings)}
      data-testid="open-settings"
    >
      <Icon name="settings" />
      {update && <span class="update-dot" aria-hidden="true" data-testid="settings-update-dot" />}
    </button>
  );
}
