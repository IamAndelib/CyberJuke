import type { Track } from '../../data/model';
import { music, musicTracks } from '../../data/ytmusic';
import { Icon } from '../icons';
import { openAlbum, openArtistPage, useSearchContext, type AlbumRef } from '../nav';
import { Tracks } from '../components/TrackList';
import { SkeletonRows } from '../components/TrackRow';
import { Screen } from '../components/Screen';
import { Cover, GlobalError, LoadMore, MUSIC_TRACK_OPTS } from '../components/Music';
import { useFeed } from '../usePaged';
import { PlayShuffle } from './Artist';

interface AlbumMeta {
  title: string;
  subtitle: string;
  thumbnailUrl?: string;
}

/** Album or playlist from Global: cover, title, artist, Play/Shuffle and the track list. */
export function AlbumPage({ album }: { album: AlbumRef }) {
  const { feed, snap } = useFeed<Track, string, AlbumMeta>(
    `album:${album.url}`,
    async (next) => {
      if (next) {
        const p = await music.more(next);
        return { items: musicTracks(p.items, album.subtitle), cursor: p.next ?? null };
      }
      const p = await music.playlist(album.url);
      // The album's own subtitle may be empty: fall back to what the search said.
      const subtitle = p.subtitle || album.subtitle;
      return {
        items: musicTracks(p.items, subtitle),
        cursor: p.next ?? null,
        meta: { title: p.title || album.title, subtitle, thumbnailUrl: p.thumbnailUrl || album.thumbnailUrl },
      };
    },
    MUSIC_TRACK_OPTS,
  );
  const meta: AlbumMeta = snap.meta ?? album;
  const kindLabel = album.label ?? (album.kind === 'album' ? 'Album' : 'Playlist');
  const tracks = snap.items;
  useSearchContext({ label: meta.title, tracks: () => tracks });

  return (
    <Screen
      testid="screen-album"
      class="album-screen"
      title={meta.title}
      subtitle={kindLabel}
      scrollKey={`album:${album.url}`}
      role="dialog"
      label={`${kindLabel}: ${meta.title}`}
      left={
        <button class="icon-btn" aria-label="Back" onClick={() => (openAlbum.value = null)} data-testid="album-back">
          <Icon name="back" />
        </button>
      }
    >
      <div class="album-head">
        <div class="dos album-cover">
          <div class="dos-frame">
            <Cover url={meta.thumbnailUrl} size="lg" />
          </div>
          <div class="dos-shadow" aria-hidden="true" />
        </div>
        <div class="album-info">
          <h2 class="album-title" data-testid="album-title">
            {meta.title}
          </h2>
          {meta.subtitle && album.kind === 'playlist' && <div class="album-artist dim">{meta.subtitle}</div>}
          {meta.subtitle && album.kind === 'album' && (
            <button class="np-link album-artist" onClick={() => openArtistPage(meta.subtitle)} data-testid="album-artist">
              {meta.subtitle}
            </button>
          )}
          <div class="dim small">
            {kindLabel}
            {snap.status === 'ready' && ` · ${tracks.length}${snap.hasMore ? '+' : ''} track${tracks.length === 1 ? '' : 's'}`}
          </div>
        </div>
      </div>
      <PlayShuffle tracks={tracks} testid="album" />
      {snap.status === 'loading' ? (
        <SkeletonRows n={6} />
      ) : snap.status === 'error' && snap.error ? (
        <GlobalError error={snap.error} onRetry={() => feed.retry()} />
      ) : (
        <>
          <Tracks tracks={tracks} />
          {snap.hasMore ? (
            <LoadMore busy={snap.loadingMore} error={!!snap.error} onClick={() => feed.loadMore()} />
          ) : (
            tracks.length > 0 && <div class="list-foot end">— end of tape —</div>
          )}
        </>
      )}
    </Screen>
  );
}
