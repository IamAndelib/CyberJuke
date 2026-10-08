import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { artistKey } from '../../data/artists';
import type { Track } from '../../data/model';
import { mergeTracks } from '../../data/search';
import { SHELF_LABEL, SHELF_ORDER, shelfToken, type MusicItem, type ReleaseKind } from '../../data/ytmusic';
import { player } from '../../player';
import { catalog } from '../../store/catalog';
import { displayArtist, jukeboxTracksBy } from '../../store/artists';
import { favoriteArtists, isFavoriteArtist, toggleFavoriteArtist } from '../../store/library';
import { toast } from '../../store/toast';
import { Icon } from '../icons';
import { openArtist, useSearchContext, type AlbumRef } from '../nav';
import { Tracks } from '../components/TrackList';
import { SkeletonRows } from '../components/TrackRow';
import { Screen } from '../components/Screen';
import {
  ARTIST_SONGS_MAX,
  AlbumShelf,
  GlobalError,
  LoadMore,
  MUSIC_ITEM_OPTS,
  MUSIC_TRACK_OPTS,
  ReleaseShelf,
  albumsLoader,
  artistPageLoader,
  artistSongsLoader,
  moreByLoader,
  releaseRef,
  type ArtistPageMeta,
  type TopCursor,
} from '../components/Music';
import { feeds, fillFeed, isFilling, type Feed } from '../feed';
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

/** Section test ids per shelf. */
const SHELF_TESTID: Record<ReleaseKind, string> = { album: 'artist-albums', live: 'artist-live', ep: 'artist-eps', single: 'artist-singles' };

/**
 * Artist page, in order: Shared on the Jukebox; then from the artist's own page Top
 * songs, Albums, Live albums, EPs and Singles (empty shelves hidden). When the artist
 * page can't be read, the channel-filtered "More by" and Albums from search instead.
 */
export function ArtistPage({ name: raw }: { name: string }) {
  const name = displayArtist(raw);
  const key = artistKey(name);
  void favoriteArtists.value;
  const fav = isFavoriteArtist(name);
  const jukebox = jukeboxTracksBy(name);
  const catalogReady = catalog.tracks.value.length > 0;

  const page = useFeed(`artistpage:${key}`, artistPageLoader(name), MUSIC_TRACK_OPTS);
  useArtistHere(name, page.feed);
  const meta = page.snap.meta;
  const failed = page.snap.status === 'error';

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

      {failed ? (
        <SearchSections name={name} />
      ) : page.snap.status === 'loading' ? (
        <div data-testid="artist-page-loading">
          <section>
            <div class="section-head">
              <h2 class="section-title">Top songs</h2>
            </div>
            <SkeletonRows n={4} />
          </section>
          <section>
            <div class="section-head">
              <h2 class="section-title">Albums</h2>
            </div>
            <ShelfSkeleton />
          </section>
        </div>
      ) : meta?.resolved === false ? null : (
        <>
          {page.snap.items.length > 0 && (
            <section data-testid="artist-top">
              <div class="section-head">
                <h2 class="section-title">Top songs</h2>
              </div>
              <PlayShuffle tracks={page.snap.items} testid="artist-top" />
              <Tracks tracks={page.snap.items} />
              {page.snap.hasMore && (
                <LoadMore busy={page.snap.loadingMore} error={!!page.snap.error} onClick={() => page.feed.loadMore()} testid="top-load-more" />
              )}
            </section>
          )}
          {meta &&
            SHELF_ORDER.map((kind) => (
              <ReleaseShelf
                key={kind}
                kind={kind}
                title={SHELF_LABEL[kind]}
                releases={meta.releases[kind]}
                artist={name}
                token={shelfToken(kind, meta.more)}
                channelId={meta.channelId}
                testid={SHELF_TESTID[kind]}
              />
            ))}
        </>
      )}
    </Screen>
  );
}

/**
 * Here search on an artist page covers everything on it: the artist's Jukebox tracks,
 * Top songs, and their full song list (read the first time Search shows Here, up to
 * ARTIST_SONGS_MAX songs, cached with the page), each song once, Jukebox first; plus
 * the releases on the page by title. Results update as the song list arrives.
 */
function useArtistHere(name: string, page: Feed<Track, TopCursor, ArtistPageMeta>): void {
  const key = artistKey(name);
  /** Bumped on every change of the page or song list: Search's reads depend on it. */
  const rev = useMemo(() => signal(0), []);
  /** Search has shown Here at least once: the song list is wanted. */
  const wanted = useRef(false);
  const url = page.snapshot.meta?.songsUrl;
  const songs = url ? feeds.get(`artistsongs:${key}`, artistSongsLoader(name, url), MUSIC_TRACK_OPTS) : null;

  useEffect(() => {
    const bump = () => rev.value++;
    const offPage = page.subscribe(bump);
    const offSongs = songs?.subscribe(bump);
    // The list can be found only once the page has loaded: start it if Search asked already.
    if (songs && wanted.current) fillFeed(songs, ARTIST_SONGS_MAX);
    bump();
    return () => {
      offPage();
      offSongs?.();
    };
  }, [page, songs]);

  const merged = useRef<{ inputs: Track[][]; out: Track[] } | null>(null);
  useSearchContext({
    label: name,
    tracks: () => {
      void rev.value;
      const inputs = [jukeboxTracksBy(name), page.snapshot.items, songs?.snapshot.items ?? []];
      const m = merged.current;
      if (m && m.inputs.every((l, i) => l === inputs[i])) return m.out;
      const out = mergeTracks([inputs[0], inputs[1], inputs[2].slice(0, ARTIST_SONGS_MAX)]);
      merged.current = { inputs, out };
      return out;
    },
    load: () => {
      wanted.current = true;
      if (songs) fillFeed(songs, ARTIST_SONGS_MAX);
      rev.value++;
    },
    loading: () => {
      void rev.value;
      if (page.snapshot.status === 'loading') return true;
      return wanted.current && !!songs && isFilling(songs.snapshot, ARTIST_SONGS_MAX);
    },
    albums: () => {
      void rev.value;
      const meta = page.snapshot.meta;
      if (!meta?.resolved) return [];
      const out: AlbumRef[] = [];
      for (const kind of SHELF_ORDER) for (const r of meta.releases[kind]) out.push(releaseRef(r, name, kind));
      return out;
    },
  });
}

/** Fallback when the artist page can't be read: "More by" and Albums from channel-filtered search. */
function SearchSections({ name }: { name: string }) {
  const key = artistKey(name);
  const jukebox = jukeboxTracksBy(name);
  const more = useFeed(`moreby:${key}`, moreByLoader(name), MUSIC_TRACK_OPTS);
  const albums = useFeed<MusicItem, never>(`albums:${key}`, albumsLoader(name), MUSIC_ITEM_OPTS);
  const shared = new Set(jukebox.map((t) => t.ytId));
  const moreTracks = more.snap.items.filter((t) => !shared.has(t.ytId));
  return (
    <>
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
    </>
  );
}
