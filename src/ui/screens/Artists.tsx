import { artistKey } from '../../data/artists';
import { catalog } from '../../store/catalog';
import { artistIndex, displayArtist } from '../../store/artists';
import { favoriteArtists } from '../../store/library';
import { toggleFavoriteArtistWithUndo } from '../../store/undo';
import { Icon } from '../icons';
import { openArtistPage } from '../nav';
import { ErrorState } from '../components/TrackList';
import { Screen } from '../components/Screen';
import { AZHead, GridSortRail } from '../components/GridSort';
import { groupAZ } from '../azSections';
import { useMemo } from 'preact/hooks';
import { takeSections, useChunks } from '../useChunks';
import type { Artist } from '../../data/artists';
import { artistsSort } from '../../store/prefs';
import { useSettled } from '../useSettled';

function ArtistTile({ name, fav }: { name: string; fav: boolean }) {
  return (
    <div class={'genre-cell' + (fav ? ' fav' : '')} data-testid="artist-cell" data-artist={name}>
      <button class="genre-tile" onClick={() => openArtistPage(name)} data-testid="artist-tile" data-artist={name}>
        <span class="artist-name">{name}</span>
      </button>
      <button
        class={'genre-fav' + (fav ? ' on' : '')}
        aria-pressed={fav}
        aria-label={fav ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
        onClick={() => toggleFavoriteArtistWithUndo(name)}
        data-testid="artist-fav"
      >
        <Icon name={fav ? 'star' : 'starOutline'} size={20} />
      </button>
    </div>
  );
}

/** Grid tiles per chunk: the first screens render at once, the rest in idle time. */
const GRID_CHUNK = 120;

/** Every artist as tiles, Popular or A–Z, rendered in chunks. */
function ArtistTiles({ list, sort, favKeys }: { list: Artist[]; sort: 'popular' | 'az'; favKeys: Set<string> }) {
  const sections = useMemo(() => (sort === 'az' ? groupAZ(list, (a) => a.name) : null), [list, sort]);
  const { shown } = useChunks(list.length, `artists:${sort}`, GRID_CHUNK, { fill: true });
  if (sections) {
    return (
      <div data-testid="artist-grid" data-sort="az">
        {takeSections(sections, shown).map((sec) => (
          <section class="az-section" key={sec.letter} data-testid="az-section" data-letter={sec.letter}>
            <AZHead letter={sec.letter} />
            <div class="genre-grid">
              {sec.items.map((a) => (
                <ArtistTile key={a.key} name={a.name} fav={favKeys.has(a.key)} />
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  }
  return (
    <div class="genre-grid" data-testid="artist-grid" data-sort="popular">
      {list.slice(0, shown).map((a) => (
        <ArtistTile key={a.key} name={a.name} fav={favKeys.has(a.key)} />
      ))}
    </div>
  );
}

/** The Artists tab's root: Favourites, then everyone on the Jukebox (Popular or A–Z). */
export function ArtistGrid() {
  const list = artistIndex.value.artists;
  const favs = favoriteArtists.value;
  // M8: the Favourites section changes on the next visit or after a scroll, never under the finger.
  const [favSection, anchor] = useSettled(favs);
  const favKeys = new Set(favs.map(artistKey));
  const status = catalog.status.value;
  const sort = artistsSort.value;

  return (
    <Screen
      testid="screen-artists"
      title="Artists"
      subtitle={list.length ? `${list.length} artists on the Jukebox` : 'Browse by artist'}
      onRefresh={() => catalog.refresh({ force: true })}
      scrollKey={`artists:${sort}`}
      right={<GridSortRail sort={artistsSort} testid="artists-sort" />}
      azScroller={sort === 'az' && list.length > 0}
    >
      <div ref={anchor} />
      {favSection.length > 0 && (
        <section data-testid="fav-artists">
          <div class="section-head">
            <h2 class="section-title">★ Favourites</h2>
          </div>
          <div class="genre-grid">
            {favSection.map((name) => (
              <ArtistTile key={artistKey(name)} name={displayArtist(name)} fav={favKeys.has(artistKey(name))} />
            ))}
          </div>
        </section>
      )}
      {favSection.length > 0 && (
        <div class="section-head">
          <h2 class="section-title">All artists</h2>
        </div>
      )}
      {status === 'error' && !list.length ? (
        <ErrorState offline={!!catalog.error.value?.offline} message="Couldn't load artists." onRetry={() => void catalog.refresh()} />
      ) : !list.length ? (
        <div class="genre-grid" aria-hidden="true" data-testid="artist-skeleton">
          {Array.from({ length: 10 }, (_, i) => (
            <div class="genre-tile skel-block" key={i} />
          ))}
        </div>
      ) : (
        <ArtistTiles list={list} sort={sort} favKeys={favKeys} />
      )}
      <p class="fineprint">Everyone whose music has been shared on the Jukebox. Tap ☆ to pin an artist to the top.</p>
    </Screen>
  );
}
