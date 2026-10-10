import { signal } from '@preact/signals';
import { useMemo, useState } from 'preact/hooks';
import { shuffled, source } from '../../data';
import { isOffline } from '../../core/errors';
import { catalog, mostSaved, type SavedRange } from '../../stores/catalog';
import { catalogGenre, chipGenres } from '../../stores/genres';
import { favoriteGenres, showNsfw } from '../../stores/library';
import { toast } from '../../stores/toast';
import { Icon } from '../../ui/icons';
import { CatalogError, EmptyState, PagedTracks, Tracks } from '../../ui/components/TrackList';
import { SkeletonRows } from '../../ui/components/TrackRow';
import { Screen } from '../../ui/components/Screen';
import { refreshCatalog } from '../../ui/refresh';
import { NewTracksPill } from './NewTracksPill';
import { Rail, RailRow, type RailItem } from '../../ui/components/Rail';
import { usePaged } from '../../ui/usePaged';
import { feedKey } from '../../stores/feed';
import { auth } from '../../data/auth';
import { list as listCtx, playAll, radio, withRest } from '../../ui/playAll';

/** Selected genre chip on Home (null = All). Survives tab switches. */
const homeGenre = signal<string | null>(null);
/** Home sort: newest posts (Firestore pages) or most saved (local catalog). */
const homeSort = signal<'latest' | 'saved'>('latest');
const savedRange = signal<SavedRange>('month');

/** Most-saved list length; beyond this it's mostly single-save noise. */
const SAVED_MAX = 100;
const SAVED_CTX = radio('Most saved');

async function shuffleJukebox(): Promise<void> {
  const all = catalog.tracks.value;
  const tracks = all.length ? shuffled(all).slice(0, 50) : await source.shuffle(50);
  if (!tracks.length) throw new Error('No tracks found');
  await playAll(tracks, { shuffle: true, ctx: listCtx('Jukebox shuffle') });
}

function ShuffleHero() {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await shuffleJukebox();
    } catch (e) {
      toast(isOffline(e) ? "You're offline" : "Couldn't shuffle right now");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="dos">
      <button class="hero dos-frame" onClick={go} data-testid="shuffle-all" aria-busy={busy}>
        <span class="hero-text">
          <span class="hero-kicker">Feeling lucky?</span>
          <span class="hero-title">Shuffle the Jukebox</span>
          <span class="hero-sub">{busy ? 'Spinning the reels…' : 'Random picks from the whole Jukebox'}</span>
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
      scrollKey={`home:${sort}:${sort === 'saved' ? savedRange.value : ''}:${g ?? ''}`}
      onRefresh={async () => {
        if (sort === 'saved') await refreshCatalog();
        else await paged.refresh();
      }}
    >
      <NewTracksPill />
      <ShuffleHero />
      <GenreChips />
      <SortRail />
      {sort === 'latest' ? <PagedTracks paged={paged} ctx={radio(g == null ? 'Home · Latest' : `Home · ${g}`)} queue={queue} chunkKey={key} /> : <MostSaved genre={g} />}
    </Screen>
  );
}
