import { computed } from '@preact/signals';
import { artistKey } from '../../data/artists';
import { catalog } from '../../stores/catalog';
import { artistIndex, displayArtist } from '../../stores/artists';
import { favoriteArtists } from '../../stores/library';
import { useFavArtist } from '../../ui/useFavs';
import { toggleFavoriteArtistWithUndo } from '../../stores/undo';
import { FavSection, FavTile } from '../../ui/components/FavTile';
import { openArtistPage, useSearchContext, type Place } from '../../ui/nav';
import { ErrorState } from '../../ui/components/TrackList';
import { Screen } from '../../ui/components/Screen';
import { AZHead, GridSortRail } from '../../ui/components/GridSort';
import { groupAZ } from '../../ui/azSections';
import { useMemo } from 'preact/hooks';
import { takeSections, useChunks } from '../../ui/useChunks';
import type { Artist } from '../../data/artists';
import { artistsSort } from '../../stores/prefs';

/** An artist tile ([FavTile]); a star re-renders only this tile. */
export function ArtistTile({ name, inGrid }: { name: string; inGrid?: boolean }) {
  const fav = useFavArtist(name);
  return <FavTile kind="artist" name={name} fav={fav} inGrid={inGrid} onOpen={() => openArtistPage(name)} onToggle={() => toggleFavoriteArtistWithUndo(name)} />;
}

/** ★ Favourites above the grid, in the order added; follows every star at once. */
function FavArtists() {
  const favs = favoriteArtists.value;
  if (!favs.length) return null;
  return (
    <FavSection testid="fav-artists" allTitle="All artists">
      {favs.map((name) => (
        <ArtistTile key={artistKey(name)} name={displayArtist(name)} />
      ))}
    </FavSection>
  );
}

/** Grid tiles per chunk: the first screens render at once, the rest in idle time. */
const GRID_CHUNK = 120;

/** Every artist as tiles, Popular or A–Z, rendered in chunks. */
export function ArtistTiles({ list, sort }: { list: Artist[]; sort: 'popular' | 'az' }) {
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
                <ArtistTile key={a.key} name={a.name} inGrid />
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
        <ArtistTile key={a.key} name={a.name} inGrid />
      ))}
    </div>
  );
}

const NO_TRACKS: never[] = [];
/** Here on the Artists tab: every artist, found by name (one array per catalog change). */
const artistPlaces = computed(() => artistIndex.value.artists.map((a): Place => ({ name: a.name, kind: 'artist' })));

/** The Artists tab's root: Favourites, then everyone on the Jukebox (Popular or A–Z). */
export function ArtistGrid() {
  const list = artistIndex.value.artists;
  // Here on this tab finds artists by name.
  useSearchContext({
    label: 'Artists',
    tracks: () => NO_TRACKS,
    places: artistPlaces,
  });
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
      <FavArtists />
      {status === 'error' && !list.length ? (
        <ErrorState offline={!!catalog.error.value?.offline} message="Couldn't load artists." onRetry={() => void catalog.refresh()} />
      ) : !list.length ? (
        <div class="genre-grid" aria-hidden="true" data-testid="artist-skeleton">
          {Array.from({ length: 10 }, (_, i) => (
            <div class="genre-tile skel-block" key={i} />
          ))}
        </div>
      ) : (
        <ArtistTiles list={list} sort={sort} />
      )}
      <p class="fineprint">Everyone whose music has been shared on the Jukebox. Tap ☆ to pin an artist to the top.</p>
    </Screen>
  );
}
