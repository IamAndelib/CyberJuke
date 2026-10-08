import { artistKey } from '../../data/artists';
import type { Track } from '../../data/model';
import type { MusicItem } from '../../data/ytmusic';
import { player } from '../../player';
import { catalog } from '../../store/catalog';
import { displayArtist, jukeboxTracksBy } from '../../store/artists';
import { favoriteArtists, isFavoriteArtist, toggleFavoriteArtist } from '../../store/library';
import { toast } from '../../store/toast';
import { Icon } from '../icons';
import { openArtist, useSearchContext } from '../nav';
import { Tracks } from '../components/TrackList';
import { SkeletonRows } from '../components/TrackRow';
import { Screen } from '../components/Screen';
import { AlbumShelf, GlobalError, LoadMore, MUSIC_ITEM_OPTS, MUSIC_TRACK_OPTS, albumsLoader, moreByLoader } from '../components/Music';
import { useFeed } from '../usePaged';

export async function playAll(tracks: Track[], shuffle: boolean): Promise<void> {
  if (!tracks.length) return;
  await player.playList(tracks, shuffle ? Math.floor(Math.random() * tracks.length) : 0);
  await player.setShuffle(shuffle);
}

export function PlayShuffle({ tracks, testid }: { tracks: Track[]; testid: string }) {
  const none = !tracks.length;
  return (
    <div class="actions">
      <button class="btn primary" disabled={none} onClick={() => playAll(tracks, false)} data-testid={`${testid}-play`}>
        <Icon name="play" size={18} /> Play
      </button>
      <button class="btn" disabled={none} onClick={() => playAll(tracks, true)} data-testid={`${testid}-shuffle`}>
        <Icon name="shuffle" size={18} /> Shuffle
      </button>
    </div>
  );
}

function ShelfSkeleton() {
  return (
    <ul class="shelf" aria-hidden="true" data-testid="album-skeleton">
      {Array.from({ length: 4 }, (_, i) => (
        <li class="shelf-item" key={i}>
          <div class="art art-md skel-block" />
          <div class="skel-line" style={{ width: '80%' }} />
        </li>
      ))}
    </ul>
  );
}

export function ArtistPage({ name: raw }: { name: string }) {
  const name = displayArtist(raw);
  const key = artistKey(name);
  void favoriteArtists.value;
  const fav = isFavoriteArtist(name);
  const jukebox = jukeboxTracksBy(name);
  useSearchContext({ label: name, tracks: () => jukeboxTracksBy(name) });
  const catalogReady = catalog.tracks.value.length > 0;

  const more = useFeed(`moreby:${key}`, moreByLoader(name), MUSIC_TRACK_OPTS);
  const albums = useFeed<MusicItem, never>(`albums:${key}`, albumsLoader(name), MUSIC_ITEM_OPTS);
  const shared = new Set(jukebox.map((t) => t.ytId));
  const moreTracks = more.snap.items.filter((t) => !shared.has(t.ytId));

  return (
    <Screen
      testid="screen-artist"
      title={name}
      subtitle="Artist"
      scrollKey={`artist:${key}`}
      left={
        <button class="icon-btn" aria-label="Back to artists" onClick={() => (openArtist.value = null)} data-testid="artist-back">
          <Icon name="back" />
        </button>
      }
      right={
        <button
          class={'icon-btn like' + (fav ? ' on' : '')}
          aria-pressed={fav}
          aria-label={fav ? `Remove ${name} from favorite artists` : `Add ${name} to favorite artists`}
          onClick={() => toast(toggleFavoriteArtist(name) ? 'Added to Favorite artists' : 'Removed from Favorite artists', 1800)}
          data-testid="artist-page-fav"
        >
          <Icon name={fav ? 'heart' : 'heartOutline'} size={26} />
        </button>
      }
      onRefresh={() => catalog.refresh({ force: true })}
    >
      <section data-testid="artist-jukebox">
        <div class="section-head">
          <h2 class="section-title">Shared on the Jukebox</h2>
          {jukebox.length > 0 && <span class="dim small">{`${jukebox.length} track${jukebox.length === 1 ? '' : 's'}`}</span>}
        </div>
        {!catalogReady ? (
          <SkeletonRows n={3} />
        ) : jukebox.length ? (
          <>
            <PlayShuffle tracks={jukebox} testid="artist-jukebox" />
            <Tracks tracks={jukebox} />
          </>
        ) : (
          <p class="section-note dim">Nothing by {name} has been shared on the Jukebox yet.</p>
        )}
      </section>

      {more.snap.meta?.resolved === false ? null : (
        <section data-testid="artist-more">
          <div class="section-head">
            <h2 class="section-title">More by {name}</h2>
          </div>
          {more.snap.status === 'loading' ? (
            <SkeletonRows n={4} />
          ) : more.snap.status === 'error' && more.snap.error ? (
            <GlobalError error={more.snap.error} onRetry={() => more.feed.retry()} />
          ) : moreTracks.length ? (
            <>
              <PlayShuffle tracks={moreTracks} testid="artist-more" />
              <Tracks tracks={moreTracks} />
              {more.snap.hasMore && <LoadMore busy={more.snap.loadingMore} error={!!more.snap.error} onClick={() => more.feed.loadMore()} />}
            </>
          ) : (
            <p class="section-note dim">Nothing more found.</p>
          )}
        </section>
      )}

      <section data-testid="artist-albums">
        <div class="section-head">
          <h2 class="section-title">Albums</h2>
        </div>
        {albums.snap.status === 'loading' ? (
          <ShelfSkeleton />
        ) : albums.snap.status === 'error' && albums.snap.error ? (
          <GlobalError error={albums.snap.error} onRetry={() => albums.feed.retry()} testid="albums-error" />
        ) : albums.snap.items.length ? (
          <AlbumShelf items={albums.snap.items} fallbackArtist={name} />
        ) : (
          <p class="section-note dim">No albums found.</p>
        )}
      </section>
    </Screen>
  );
}
