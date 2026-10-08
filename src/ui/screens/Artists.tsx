import { artistKey } from '../../data/artists';
import { catalog } from '../../store/catalog';
import { artistIndex, displayArtist } from '../../store/artists';
import { favoriteArtists, toggleFavoriteArtist } from '../../store/library';
import { Icon } from '../icons';
import { openArtist } from '../nav';
import { ErrorState } from '../components/TrackList';
import { Screen } from '../components/Screen';
import { AZHead, GridSortRail } from '../components/GridSort';
import { groupAZ } from '../azSections';
import { artistsSort } from '../../store/prefs';
import { ArtistPage } from './Artist';

export function Artists() {
  if (openArtist.value) return <ArtistPage name={openArtist.value} />;
  return <ArtistGrid />;
}

function ArtistTile({ name, fav }: { name: string; fav: boolean }) {
  return (
    <div class={'genre-cell' + (fav ? ' fav' : '')} data-testid="artist-cell" data-artist={name}>
      <button class="genre-tile" onClick={() => (openArtist.value = name)} data-testid="artist-tile" data-artist={name}>
        <span class="artist-name">{name}</span>
      </button>
      <button
        class={'genre-fav' + (fav ? ' on' : '')}
        aria-pressed={fav}
        aria-label={fav ? `Remove ${name} from favorite artists` : `Add ${name} to favorite artists`}
        onClick={() => toggleFavoriteArtist(name)}
        data-testid="artist-fav"
      >
        <Icon name={fav ? 'heart' : 'heartOutline'} size={20} />
      </button>
    </div>
  );
}

function ArtistGrid() {
  const list = artistIndex.value.artists;
  const favs = favoriteArtists.value;
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
      {favs.length > 0 && (
        <section data-testid="fav-artists">
          <div class="section-head">
            <h2 class="section-title">Favorite artists</h2>
          </div>
          <div class="genre-grid">
            {favs.map((name) => (
              <ArtistTile key={artistKey(name)} name={displayArtist(name)} fav />
            ))}
          </div>
        </section>
      )}
      {favs.length > 0 && (
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
      ) : sort === 'az' ? (
        <div data-testid="artist-grid" data-sort="az">
          {groupAZ(list, (a) => a.name).map((sec) => (
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
      ) : (
        <div class="genre-grid" data-testid="artist-grid" data-sort="popular">
          {list.map((a) => (
            <ArtistTile key={a.key} name={a.name} fav={favKeys.has(a.key)} />
          ))}
        </div>
      )}
      <p class="fineprint">Everyone whose music has been shared on the Jukebox. Tap the heart to pin an artist to the top.</p>
    </Screen>
  );
}
