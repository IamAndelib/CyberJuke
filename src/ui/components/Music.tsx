/**
 * Pieces for Global (YouTube Music) content: square covers, the albums shelf, the
 * artist page's discography shelves and grid, album/playlist/artist result rows, and
 * the error box. Never names the provider.
 */
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  RELEASE_LABEL,
  groupReleases,
  shelfToken,
  isByArtist,
  isEndOfList,
  itemChannelId,
  music,
  musicErrorText,
  musicTracks,
  type MusicFilter,
  type MusicItem,
  type MusicErrorCode,
  type MusicPage,
  type Release,
  type ReleaseKind,
} from '../../data/ytmusic';
import { artistChannels } from '../../store/artistChannels';
import type { Track } from '../../data/model';
import type { FeedError, FeedLoader, FeedOptions } from '../feed';
import { Icon } from '../icons';
import { openAlbumPage, openArtistPage, openReleases, type AlbumRef } from '../nav';

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

export function releaseRef(r: Release, artist: string, kind: ReleaseKind = r.kind): AlbumRef {
  return { url: r.url, title: r.title, subtitle: artist, thumbnailUrl: r.thumbnailUrl, kind: 'album', label: RELEASE_LABEL[kind] };
}

/** One release: square cover, title, year. Opens the album page. */
export function ReleaseCard({ release, artist, kind }: { release: Release; artist: string; kind: ReleaseKind }) {
  const label = RELEASE_LABEL[kind];
  return (
    <button
      class="shelf-btn release-btn"
      onClick={() => openAlbumPage(releaseRef(release, artist, kind))}
      data-testid="release-card"
      data-kind={kind}
      aria-label={`Open ${label.toLowerCase()} ${release.title}${release.year ? `, ${release.year}` : ''}`}
    >
      <Cover url={release.thumbnailUrl} size="md" />
      <span class="shelf-title" data-testid="release-title">
        {release.title}
      </span>
      {release.year && (
        <span class="shelf-year" data-testid="release-year">
          {release.year}
        </span>
      )}
    </button>
  );
}

/**
 * One discography shelf on the artist page (Albums, Live albums, EPs, Singles): a
 * horizontal row of covers, and "See all" when the artist page offers the full list.
 * Hidden when empty.
 */
export function ReleaseShelf({
  kind,
  title,
  releases,
  artist,
  token,
  channelId,
  testid,
}: {
  kind: ReleaseKind;
  title: string;
  releases: Release[];
  artist: string;
  token?: string;
  channelId?: string;
  testid: string;
}) {
  if (!releases.length) return null;
  return (
    <section data-testid={testid} data-kind={kind}>
      <div class="section-head">
        <h2 class="section-title">{title}</h2>
        {token && channelId && (
          <button
            class="link-btn see-all"
            onClick={() => (openReleases.value = { artist, channelId, kind, token })}
            aria-label={`See all ${title.toLowerCase()} by ${artist}`}
            data-testid="see-all"
          >
            [See all]
          </button>
        )}
      </div>
      <ul class="shelf" data-testid="release-shelf">
        {releases.map((r) => (
          <li key={r.url} class="shelf-item">
            <ReleaseCard release={r} artist={artist} kind={kind} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Every release of one shelf as a grid ("See all"). */
export function ReleaseGrid({ releases, artist, kind }: { releases: Release[]; artist: string; kind: ReleaseKind }) {
  return (
    <ul class="release-grid" data-testid="release-grid">
      {releases.map((r) => (
        <li key={r.url}>
          <ReleaseCard release={r} artist={artist} kind={kind} />
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
        onClick={() => {
          if (!isArtist) return openAlbumPage(albumRef(item));
          // The channel is known already: the artist page needs no lookup.
          artistChannels.remember(item.title, itemChannelId(item));
          openArtistPage(item.title);
        }}
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

/** "More by" stops paging after this many matches, or MORE_BY_PAGES pages. */
export const MORE_BY_TARGET = 20;
export const MORE_BY_PAGES = 3;

type ByCursor = { next: string; channel: string };
/** `resolved: false`: no artist matched the name exactly, so the section is hidden. */
export interface MoreByMeta {
  resolved: boolean;
}

/**
 * "More by <artist>": songs whose first credited artist is this artist's channel
 * (exact, so "Ivy Queen" never shows up for "Queen"), as Tracks. Each load pages on
 * until MORE_BY_TARGET matches or MORE_BY_PAGES pages.
 */
export function moreByLoader(artist: string): FeedLoader<Track, ByCursor, MoreByMeta> {
  return async (c) => {
    const channel = c?.channel ?? (await artistChannels.get(artist));
    if (!channel) return { items: [], cursor: null, meta: { resolved: false } };
    const found: MusicItem[] = [];
    let next: string | null = c?.next ?? null;
    for (let pages = 0; pages < MORE_BY_PAGES && found.length < MORE_BY_TARGET; pages++) {
      let p: MusicPage;
      try {
        p = !c && pages === 0 ? await music.search(artist, 'songs') : await music.more(next!);
      } catch (e) {
        if (pages === 0 && !(c && isEndOfList(e))) throw e;
        if (isEndOfList(e)) next = null;
        break; // keep what we have; a later "Load more" retries from `next`
      }
      found.push(...p.items.filter((i) => i.kind === 'song' && isByArtist(i, channel, artist)));
      next = p.next ?? null;
      if (!next) break;
    }
    return { items: musicTracks(found, artist), cursor: next ? { next, channel } : null, meta: { resolved: true } };
  };
}

// ---- The artist's own page -------------------------------------------------------------

/** Top songs page through the artist's songs playlist, then that playlist's own pages. */
export type TopCursor = { playlist: string } | { next: string };

export interface ArtistPageMeta {
  /** false: no artist matched the name exactly (nothing but the Jukebox is shown). */
  resolved: boolean;
  channelId?: string;
  releases: Record<ReleaseKind, Release[]>;
  more: { albums?: string; singles?: string };
}

const NO_RELEASES = (): Record<ReleaseKind, Release[]> => ({ album: [], live: [], ep: [], single: [] });

/**
 * The artist page: Top songs as Tracks (exactly the artist's, from their own page) with
 * "Load more" through the songs playlist, and the releases by shelf in meta. Rejects
 * when the page can't be read, so the caller falls back to channel-filtered search.
 */
export function artistPageLoader(artist: string): FeedLoader<Track, TopCursor, ArtistPageMeta> {
  return async (c) => {
    if (c) {
      const p = 'playlist' in c ? await music.playlist(c.playlist) : await music.more(c.next);
      return { items: musicTracks(p.items, artist), cursor: p.next ? { next: p.next } : null };
    }
    const channel = await artistChannels.get(artist);
    if (!channel) return { items: [], cursor: null, meta: { resolved: false, releases: NO_RELEASES(), more: {} } };
    const page = await music.artistPage(channel);
    return {
      items: musicTracks(page.topSongs, artist),
      cursor: page.topSongsPlaylistUrl ? { playlist: page.topSongsPlaylistUrl } : null,
      meta: { resolved: true, channelId: channel, releases: groupReleases(page.releases), more: page.more ?? {} },
    };
  };
}

/**
 * "See all": one shelf's releases from the full list behind its token. Tokens are
 * opaque and can be evicted native-side (UNAVAILABLE), so every load after the first
 * (a Retry) reloads the artist page first for a fresh token; without one, the
 * shelf's releases from the page itself are shown.
 */
export function releasesLoader(ref: { channelId: string; kind: ReleaseKind; token: string }, onFreshPage?: () => void): FeedLoader<Release, never> {
  // Kept outside the closure: the feed gets a new loader on every render.
  const k = `${ref.token}|${ref.kind}`;
  return async () => {
    const n = releaseLoads.get(k) ?? 0;
    releaseLoads.set(k, n + 1);
    if (releaseLoads.size > 50) releaseLoads.delete(releaseLoads.keys().next().value!);
    let token: string | undefined = ref.token;
    if (n > 0) {
      const page = await music.artistPage(ref.channelId, true);
      onFreshPage?.();
      token = shelfToken(ref.kind, page.more);
      if (!token) return { items: groupReleases(page.releases)[ref.kind], cursor: null };
    }
    const all = await music.artistReleases(token);
    return { items: groupReleases(all)[ref.kind], cursor: null };
  };
}
const releaseLoads = new Map<string, number>();

/** Albums by the artist's channel (first page only); empty when the artist isn't resolved. */
export function albumsLoader(artist: string): FeedLoader<MusicItem, never> {
  return async () => {
    const channel = await artistChannels.get(artist);
    if (!channel) return { items: [], cursor: null };
    const p = await music.search(artist, 'albums');
    const albums = p.items.filter((i) => (i.kind === 'album' || i.kind === 'playlist') && isByArtist(i, channel, artist));
    return { items: albums, cursor: null };
  };
}
