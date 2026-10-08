import { source } from '../../data';
import { catalog } from '../../stores/catalog';
import { catalogGenre, genres, genresComplete } from '../../stores/genres';
import { favoriteGenres, showNsfw } from '../../stores/library';
import { toggleFavoriteGenreWithUndo } from '../../stores/undo';
import { useMemo } from 'preact/hooks';
import { takeSections, useChunks } from '../useChunks';
import { Icon } from '../icons';
import { openGenrePage, popPage, useSearchContext } from '../nav';
import { ErrorState, PagedTracks, PlayShuffle } from '../components/TrackList';
import { Screen } from '../components/Screen';
import { AZHead, GridSortRail } from '../components/GridSort';
import { groupAZ } from '../azSections';
import type { GenreCount } from '../../stores/genres';
import { genresSort } from '../../stores/prefs';
import { usePaged } from '../usePaged';
import { authScope } from '../feed';
import { auth } from '../../data/auth';
import { list as listCtx, withRest } from '../playAll';
import { useSettled } from '../useSettled';

function GenreTile({ name, fav }: { name: string; fav: boolean }) {
  return (
    <div class={'genre-cell' + (fav ? ' fav' : '')} data-testid="genre-cell" data-genre={name}>
      <button class="genre-tile" onClick={() => openGenrePage(name)} data-testid="genre-tile" data-genre={name}>
        <span class="genre-name">{name}</span>
      </button>
      <button
        class={'genre-fav' + (fav ? ' on' : '')}
        aria-pressed={fav}
        aria-label={fav ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
        onClick={() => toggleFavoriteGenreWithUndo(name)}
        data-testid="genre-fav"
      >
        <Icon name={fav ? 'star' : 'starOutline'} size={20} />
      </button>
    </div>
  );
}

/** The Genres tab's root: Favourites, then every genre (Popular or A–Z). */
export function GenreGrid() {
  const list = genres.value;
  const favs = favoriteGenres.value;
  // M8: the Favourites section changes on the next visit or after a scroll, never under the finger.
  const [favSection, anchor] = useSettled(favs);
  const status = catalog.status.value;
  const complete = genresComplete.value;
  const sort = genresSort.value;

  return (
    <Screen
      testid="screen-genres"
      title="Genres"
      subtitle={complete ? `${list.length} genres on the Jukebox` : 'Browse by genre'}
      onRefresh={() => catalog.refresh({ force: true })}
      scrollKey={`genres:${sort}`}
      right={<GridSortRail sort={genresSort} testid="genres-sort" />}
      azScroller={sort === 'az' && list.length > 0}
    >
      <div ref={anchor} />
      {favSection.length > 0 && (
        <section data-testid="fav-genres">
          <div class="section-head">
            <h2 class="section-title">★ Favourites</h2>
          </div>
          <div class="genre-grid">
            {favSection.map((name) => (
              <GenreTile key={name} name={name} fav={favs.includes(name)} />
            ))}
          </div>
        </section>
      )}
      {favSection.length > 0 && (
        <div class="section-head">
          <h2 class="section-title">All genres</h2>
        </div>
      )}
      {status === 'error' && !list.length ? (
        <ErrorState
          offline={!!catalog.error.value?.offline}
          message="Couldn't load genres."
          onRetry={() => void catalog.refresh()}
        />
      ) : !list.length ? (
        <div class="genre-grid" aria-hidden="true" data-testid="genre-skeleton">
          {Array.from({ length: 10 }, (_, i) => (
            <div class="genre-tile skel-block" key={i} />
          ))}
        </div>
      ) : (
        <GenreTiles list={list} sort={sort} favs={favs} />
      )}
      <p class="fineprint">Genres are free text chosen by each poster. Tap ☆ to pin a genre to the top.</p>
    </Screen>
  );
}

/** Grid tiles per chunk: the first screens render at once, the rest in idle time. */
const GRID_CHUNK = 120;

/** Every genre as tiles, Popular or A–Z, rendered in chunks. */
function GenreTiles({ list, sort, favs }: { list: GenreCount[]; sort: 'popular' | 'az'; favs: string[] }) {
  const sections = useMemo(() => (sort === 'az' ? groupAZ(list, (g) => g.name) : null), [list, sort]);
  const { shown } = useChunks(list.length, `genres:${sort}`, GRID_CHUNK, { fill: true });
  if (sections) {
    return (
      <div data-testid="genre-grid" data-sort="az">
        {takeSections(sections, shown).map((sec) => (
          <section class="az-section" key={sec.letter} data-testid="az-section" data-letter={sec.letter}>
            <AZHead letter={sec.letter} />
            <div class="genre-grid">
              {sec.items.map((g) => (
                <GenreTile key={g.name} name={g.name} fav={favs.includes(g.name)} />
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  }
  return (
    <div class="genre-grid" data-testid="genre-grid" data-sort="popular">
      {list.slice(0, shown).map((g) => (
        <GenreTile key={g.name} name={g.name} fav={favs.includes(g.name)} />
      ))}
    </div>
  );
}

/** One genre's tracks, opened in place on the current tab. */
export function GenreDetail({ genre }: { genre: string }) {
  const nsfw = showNsfw.value;
  const scope = authScope(auth.state.value.status === 'signedIn');
  const feedKey = `genre:${scope}:${genre}:${nsfw}`;
  const paged = usePaged(feedKey, async (c) => {
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
          ? `${count} track${count === 1 ? '' : 's'}`
          : has
            ? `${paged.tracks.length}${paged.hasMore ? '+' : ''} tracks`
            : 'Genre'
      }
      left={
        <button class="icon-btn" aria-label="Back" onClick={popPage} data-testid="genre-back">
          <Icon name="back" />
        </button>
      }
      onRefresh={paged.refresh}
      scrollKey={`genre:${genre}`}
    >
      <PlayShuffle tracks={full} ctx={ctx} testid="genre" disabled={!has} playTestid="genre-play-all" shuffleTestid="genre-shuffle" />
      <PagedTracks paged={paged} ctx={ctx} queue={full} hideGenre chunkKey={feedKey} />
    </Screen>
  );
}
