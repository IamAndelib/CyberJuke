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
import { refreshCatalog } from '../../ui/refresh';
import { GridSortRail, TileGrid, TileSkeleton } from '../../ui/components/GridSort';
import type { Artist } from '../../data/artists';
import { artistsSort, type GridSort } from '../../stores/prefs';

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

/** Every artist as tiles, Popular or A–Z (perf.spec counts its renders by this name). */
export function ArtistTiles({ list, sort }: { list: Artist[]; sort: GridSort }) {
  return <TileGrid list={list} sort={sort} nameOf={artistName} tile={artistTile} testid="artist-grid" chunkKey="artists" />;
}

const artistName = (a: Artist) => a.name;
const artistTile = (a: Artist) => <ArtistTile key={a.key} name={a.name} inGrid />;

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
      onRefresh={refreshCatalog}
      scrollKey={`artists:${sort}`}
      right={<GridSortRail sort={artistsSort} testid="artists-sort" />}
      azScroller={sort === 'az' && list.length > 0}
    >
      <FavArtists />
      {status === 'error' && !list.length ? (
        <ErrorState offline={!!catalog.error.value?.offline} message="Couldn't load artists." onRetry={() => void catalog.refresh()} />
      ) : !list.length ? (
        <TileSkeleton testid="artist-skeleton" />
      ) : (
        <ArtistTiles list={list} sort={sort} />
      )}
      <p class="fineprint">Everyone whose music has been shared on the Jukebox. Tap ☆ to pin an artist to the top.</p>
    </Screen>
  );
}
