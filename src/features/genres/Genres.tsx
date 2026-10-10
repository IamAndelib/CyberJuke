import { computed } from '@preact/signals';
import { source } from '../../data';
import { catalog } from '../../stores/catalog';
import { catalogGenre, genres, genresComplete } from '../../stores/genres';
import { favoriteGenres, showNsfw } from '../../stores/library';
import { useFavGenre } from '../../ui/useFavs';
import { toggleFavoriteGenreWithUndo } from '../../stores/undo';
import { Icon } from '../../ui/icons';
import { FavSection, FavTile, PageStar } from '../../ui/components/FavTile';
import { openGenrePage, popPage, useSearchContext, type Place } from '../../ui/nav';
import { ErrorState, PagedTracks, PlayShuffle } from '../../ui/components/TrackList';
import { Screen } from '../../ui/components/Screen';
import { refreshCatalog } from '../../ui/refresh';
import { GridSortRail, TileGrid, TileSkeleton } from '../../ui/components/GridSort';
import type { GenreCount } from '../../data/search';
import { genresSort, type GridSort } from '../../stores/prefs';
import { usePaged } from '../../ui/usePaged';
import { feedKey } from '../../stores/feed';
import { auth } from '../../data/auth';
import { list as listCtx, withRest } from '../../ui/playAll';
import { plural } from '../../core/text';

/** A genre tile ([FavTile]); a star re-renders only this tile. */
export function GenreTile({ name, inGrid }: { name: string; inGrid?: boolean }) {
  const fav = useFavGenre(name);
  return <FavTile kind="genre" name={name} fav={fav} inGrid={inGrid} onOpen={() => openGenrePage(name)} onToggle={() => toggleFavoriteGenreWithUndo(name)} />;
}

const NO_TRACKS: never[] = [];
/** Here on the Genres tab: every genre, found by name (one array per catalog change). */
const genrePlaces = computed(() => genres.value.map((g): Place => ({ name: g.name, kind: 'genre', count: g.count })));

/** The Genres tab's root: Favourites, then every genre (Popular or A–Z). */
export function GenreGrid() {
  const list = genres.value;
  // Here on this tab finds genres by name.
  useSearchContext({
    label: 'Genres',
    tracks: () => NO_TRACKS,
    places: genrePlaces,
  });
  const status = catalog.status.value;
  const complete = genresComplete.value;
  const sort = genresSort.value;

  return (
    <Screen
      testid="screen-genres"
      title="Genres"
      subtitle={complete ? `${list.length} genres on the Jukebox` : 'Browse by genre'}
      onRefresh={refreshCatalog}
      scrollKey={`genres:${sort}`}
      right={<GridSortRail sort={genresSort} testid="genres-sort" />}
      azScroller={sort === 'az' && list.length > 0}
    >
      <FavGenres />
      {/* The catalog failed: said so even over the genres seen on Home meanwhile (a part). */}
      {status === 'error' && !complete && (
        <ErrorState offline={!!catalog.error.value?.offline} message="Couldn't load genres." onRetry={() => void catalog.refresh()} />
      )}
      {list.length ? (
        <GenreTiles list={list} sort={sort} />
      ) : status !== 'error' ? (
        <TileSkeleton testid="genre-skeleton" />
      ) : null}
      <p class="fineprint">Genres are free text chosen by each poster. Tap ☆ to pin a genre to the top.</p>
    </Screen>
  );
}

/** ★ Favourites above the grid, in the order added; follows every star at once. */
function FavGenres() {
  const favs = favoriteGenres.value;
  if (!favs.length) return null;
  return (
    <FavSection testid="fav-genres" allTitle="All genres">
      {favs.map((name) => (
        <GenreTile key={name} name={name} />
      ))}
    </FavSection>
  );
}

/** Every genre as tiles, Popular or A–Z (perf.spec counts its renders by this name). */
export function GenreTiles({ list, sort }: { list: GenreCount[]; sort: GridSort }) {
  return <TileGrid list={list} sort={sort} nameOf={genreName} tile={genreTile} testid="genre-grid" chunkKey="genres" />;
}

const genreName = (g: GenreCount) => g.name;
const genreTile = (g: GenreCount) => <GenreTile key={g.name} name={g.name} inGrid />;

/** One genre's tracks, opened in place on the current tab. */
export function GenreDetail({ genre }: { genre: string }) {
  const nsfw = showNsfw.value;
  const key = feedKey.genre(auth.state.value.status === 'signedIn', genre, nsfw);
  const paged = usePaged(key, async (c) => {
    const p = await source.byGenre(genre, c);
    // Some posts only carry the genre on the attachment, which the query can't see:
    // fall back to the local catalog rather than showing an empty genre. Opened
    // before the catalog has loaded, it waits for it, so the page fills in by itself.
    if (!c && !p.tracks.length) {
      if (!catalog.tracks.value.length) await catalog.refresh();
      return { tracks: catalog.tracks.value.filter((t) => t.genre === genre), cursor: null };
    }
    return p;
  });
  const has = paged.tracks.length > 0;
  const all = catalogGenre(genre);
  // P2: the whole genre (every catalog track in it), of which the pages are the start.
  const full = () => withRest(paged.tracks, catalogGenre(genre));
  const count = all.length >= paged.tracks.length ? all.length : null;
  const ctx = listCtx(genre);
  // Here: every catalog track in this genre (what the page pages through), or the
  // pages loaded so far while the catalog is still loading.
  useSearchContext({
    label: genre,
    tracks: () => {
      const cat = catalogGenre(genre);
      return cat.length >= paged.tracks.length ? cat : paged.tracks;
    },
  });
  return (
    <Screen
      testid="screen-genre"
      title={genre}
      subtitle={
        count != null && count > 0
          ? plural(count, 'track')
          : has
            ? `${paged.tracks.length}${paged.hasMore ? '+' : ''} tracks`
            : 'Genre'
      }
      left={
        <button class="icon-btn" aria-label="Back" onClick={popPage} data-testid="genre-back">
          <Icon name="back" />
        </button>
      }
      right={<GenreFavButton genre={genre} />}
      onRefresh={paged.refresh}
      scrollKey={`genre:${genre}`}
    >
      <PlayShuffle tracks={full} ctx={ctx} testid="genre" disabled={!has} playTestid="genre-play-all" shuffleTestid="genre-shuffle" />
      <PagedTracks paged={paged} ctx={ctx} queue={full} hideGenre chunkKey={key} />
    </Screen>
  );
}

/** The genre page's star (starred here, on the grid or by an Undo: it follows). */
function GenreFavButton({ genre }: { genre: string }) {
  const fav = useFavGenre(genre);
  return <PageStar name={genre} fav={fav} onToggle={() => toggleFavoriteGenreWithUndo(genre)} testid="genre-page-fav" />;
}
