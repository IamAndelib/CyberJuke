import type { Track } from '../../data/model';
import { source } from '../../data';
import { player } from '../../player';
import { catalog } from '../../store/catalog';
import { genres, genresComplete } from '../../store/genres';
import { favoriteGenres, showNsfw, toggleFavoriteGenre } from '../../store/library';
import { useMemo } from 'preact/hooks';
import { takeSections, useChunks } from '../useChunks';
import { Icon } from '../icons';
import { openGenre, useSearchContext } from '../nav';
import { ErrorState, PagedTracks } from '../components/TrackList';
import { Screen } from '../components/Screen';
import { AZHead, GridSortRail } from '../components/GridSort';
import { groupAZ } from '../azSections';
import type { GenreCount } from '../../store/genres';
import { genresSort } from '../../store/prefs';
import { usePaged } from '../usePaged';
import { authScope } from '../feed';
import { auth } from '../../data/auth';

export function Genres() {
  if (openGenre.value) return <GenreDetail genre={openGenre.value} />;
  return <GenreGrid />;
}

function GenreTile({ name, fav }: { name: string; fav: boolean }) {
  return (
    <div class={'genre-cell' + (fav ? ' fav' : '')} data-testid="genre-cell" data-genre={name}>
      <button class="genre-tile" onClick={() => (openGenre.value = name)} data-testid="genre-tile" data-genre={name}>
        <span class="genre-name">{name}</span>
      </button>
      <button
        class={'genre-fav' + (fav ? ' on' : '')}
        aria-pressed={fav}
        aria-label={fav ? `Remove ${name} from favorite genres` : `Add ${name} to favorite genres`}
        onClick={() => toggleFavoriteGenre(name)}
        data-testid="genre-fav"
      >
        <Icon name={fav ? 'heart' : 'heartOutline'} size={20} />
      </button>
    </div>
  );
}

function GenreGrid() {
  const list = genres.value;
  const favs = favoriteGenres.value;
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
      {favs.length > 0 && (
        <section data-testid="fav-genres">
          <div class="section-head">
            <h2 class="section-title">Favorite genres</h2>
          </div>
          <div class="genre-grid">
            {favs.map((name) => (
              <GenreTile key={name} name={name} fav />
            ))}
          </div>
        </section>
      )}
      {favs.length > 0 && (
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
      <p class="fineprint">Genres are free text chosen by each poster. Tap the heart to pin a genre to the top.</p>
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

/** Catalog tracks of one genre, recomputed only when the catalog changes. */
let genreMemo: { src: Track[]; genre: string; out: Track[] } | null = null;
function catalogGenre(genre: string): Track[] {
  const src = catalog.tracks.value;
  if (genreMemo?.src !== src || genreMemo.genre !== genre) {
    genreMemo = { src, genre, out: src.filter((t) => t.genre === genre) };
  }
  return genreMemo.out;
}

function GenreDetail({ genre }: { genre: string }) {
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
  // Here: every catalog track in this genre (what the page pages through), or the
  // pages loaded so far while the catalog is still loading.
  useSearchContext({
    label: genre,
    tracks: () => {
      const all = catalogGenre(genre);
      return all.length >= paged.tracks.length ? all : paged.tracks;
    },
  });
  return (
    <Screen
      testid="screen-genre"
      title={genre}
      subtitle={has ? `${paged.tracks.length}${paged.hasMore ? '+' : ''} tracks` : 'Genre'}
      left={
        <button class="icon-btn" aria-label="Back to genres" onClick={() => (openGenre.value = null)} data-testid="genre-back">
          <Icon name="back" />
        </button>
      }
      onRefresh={paged.refresh}
      scrollKey={`genre:${genre}`}
    >
      <div class="actions">
        <button class="btn primary" disabled={!has} onClick={() => player.playList(paged.tracks, 0)} data-testid="genre-play-all">
          <Icon name="play" size={18} /> Play all
        </button>
        <button
          class="btn"
          disabled={!has}
          onClick={async () => {
            const n = paged.tracks.length;
            await player.playList(paged.tracks, Math.floor(Math.random() * n));
            await player.setShuffle(true);
          }}
          data-testid="genre-shuffle"
        >
          <Icon name="shuffle" size={18} /> Shuffle
        </button>
      </div>
      <PagedTracks paged={paged} hideGenre chunkKey={feedKey} />
    </Screen>
  );
}
