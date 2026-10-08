/**
 * Pieces for Global (YouTube Music) content: square covers, the albums shelf,
 * album/playlist/artist result rows, and the error box. Never names the provider.
 */
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { pickByArtist } from '../../data/artists';
import { isEndOfList, music, musicErrorText, musicTracks, type MusicFilter, type MusicItem, type MusicErrorCode } from '../../data/ytmusic';
import type { Track } from '../../data/model';
import type { FeedError, FeedLoader, FeedOptions } from '../feed';
import { Icon } from '../icons';
import { openAlbumPage, openArtistPage, type AlbumRef } from '../nav';

/** Square cover art (albums, playlists, artists) with the same pixel treatment as track art. */
export function Cover({ url, size = 'md', round, class: cls }: { url?: string; size?: 'sm' | 'md' | 'lg'; round?: boolean; class?: string }) {
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const failed = !url || failedFor === url;
  return (
    <div class={`art art-cover art-${size}${round ? ' art-round' : ''}${cls ? ' ' + cls : ''}`} aria-hidden="true">
      {failed ? (
        <div class="art-ph">
          <Icon name={round ? 'artists' : 'note'} size={size === 'lg' ? 72 : 24} />
        </div>
      ) : (
        <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailedFor(url!)} />
      )}
    </div>
  );
}

export function albumRef(item: MusicItem, fallbackArtist = ''): AlbumRef {
  return {
    url: item.url,
    title: item.title,
    subtitle: item.subtitle || fallbackArtist,
    thumbnailUrl: item.thumbnailUrl,
    kind: item.kind === 'album' ? 'album' : 'playlist',
  };
}

/** Horizontal row of album covers. */
export function AlbumShelf({ items, fallbackArtist, testid = 'album-shelf' }: { items: MusicItem[]; fallbackArtist?: string; testid?: string }) {
  return (
    <ul class="shelf" data-testid={testid}>
      {items.map((it) => (
        <li key={it.url} class="shelf-item">
          <button class="shelf-btn" onClick={() => openAlbumPage(albumRef(it, fallbackArtist))} data-testid="album-card" aria-label={`Open album ${it.title}`}>
            <Cover url={it.thumbnailUrl} size="md" />
            <span class="shelf-title">{it.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** An album, playlist or artist in Global search results. */
export function MusicRow({ item }: { item: MusicItem }) {
  const isArtist = item.kind === 'artist';
  const sub = isArtist
    ? 'Artist'
    : [item.kind === 'album' ? 'Album' : 'Playlist', item.subtitle, item.itemCount ? `${item.itemCount} tracks` : ''].filter(Boolean).join(' · ');
  return (
    <li class="row" data-testid="music-row" data-kind={item.kind}>
      <button
        class="row-main"
        onClick={() => (isArtist ? openArtistPage(item.title) : openAlbumPage(albumRef(item)))}
        aria-label={`${isArtist ? 'Open artist' : item.kind === 'album' ? 'Open album' : 'Open playlist'} ${item.title}`}
        data-testid="music-open"
      >
        <div class="row-art">
          <Cover url={item.thumbnailUrl} size="sm" round={isArtist} />
        </div>
        <div class="row-text">
          <div class="row-title" data-testid="music-title">
            {item.title}
          </div>
          <div class="row-artist">{sub}</div>
        </div>
        <span class="row-go" aria-hidden="true">
          <Icon name="back" size={20} class="flip" />
        </span>
      </button>
    </li>
  );
}

export function GlobalError({ error, onRetry, testid = 'global-error' }: { error: FeedError; onRetry?: () => void; testid?: string }) {
  return (
    <div class="state compact" role="alert" data-testid={testid} data-code={error.code}>
      <div class="state-glyph" aria-hidden="true">
        [ NO SIGNAL ]
      </div>
      <div class="state-body">{musicErrorText({ code: (error.code as MusicErrorCode) ?? 'UNAVAILABLE' })}</div>
      {onRetry && (
        <button class="btn" onClick={onRetry} data-testid="global-retry">
          <Icon name="refresh" size={18} /> Retry
        </button>
      )}
    </div>
  );
}

export function LoadMore({ busy, onClick, error, children = 'Load more', testid = 'load-more' }: { busy: boolean; onClick: () => void; error?: boolean; children?: ComponentChildren; testid?: string }) {
  return (
    <div class="list-foot">
      <button class="btn" onClick={onClick} disabled={busy} aria-busy={busy} data-testid={testid}>
        {busy ? <span class="spinner" aria-hidden="true" /> : <Icon name={error ? 'refresh' : 'down'} size={18} />}
        {busy ? 'Loading…' : error ? 'Retry' : children}
      </button>
    </div>
  );
}

// ---- Feeds ----------------------------------------------------------------------------

export const MUSIC_ITEM_OPTS: FeedOptions<MusicItem> = { id: (i) => i.kind + '|' + i.url, isEnd: isEndOfList };
export const MUSIC_TRACK_OPTS: FeedOptions<Track> = { id: (t) => t.id, isEnd: isEndOfList };

/** Global search results for one filter (raw items; songs are mapped by the caller). */
export function searchLoader(query: string, filter: MusicFilter): FeedLoader<MusicItem, string> {
  return async (next) => {
    const p = next ? await music.more(next) : await music.search(query, filter);
    return { items: p.items, cursor: p.next ?? null };
  };
}

type ByCursor = { next: string; all: boolean };

/** "More by <artist>": songs for the artist, as Tracks. */
export function moreByLoader(artist: string): FeedLoader<Track, ByCursor> {
  return async (c) => {
    const p = c ? await music.more(c.next) : await music.search(artist, 'songs');
    const r = pickByArtist(musicTracks(p.items, artist), artist, (t) => t.artist, c ? c.all : null);
    return { items: r.items, cursor: p.next ? { next: p.next, all: r.all } : null };
  };
}

/** Albums for the artist (first page only). */
export function albumsLoader(artist: string): FeedLoader<MusicItem, never> {
  return async () => {
    const p = await music.search(artist, 'albums');
    const albums = p.items.filter((i) => i.kind === 'album' || i.kind === 'playlist');
    return { items: pickByArtist(albums, artist, (i) => i.subtitle, null).items, cursor: null };
  };
}
