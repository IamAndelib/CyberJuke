/**
 * Local songs as albums and artists, from their tags, the way music players group them
 * (Android's own media library, Quod Libet, Auxio):
 * - a song belongs to its album artist, or its artist when it has none (the full credit, not split);
 * - an album is its name and that artist, so two "Greatest Hits" stay apart. Names match
 *   whatever their case and spacing ("TOOL", "Tool"), and show in their most common spelling;
 * - an album's songs go by disc, then track, then title; an artist's albums newest first;
 * - songs with no album tag, whoever they're by, make one "Unknown album" at the end of the
 *   albums (by title); "Unknown artist" comes last among the artists.
 * Pure (localGroups.test.ts).
 */
import { localArtUrl, type LocalSong } from './local';

export interface LocalAlbum {
  /** Its name and artist, matched loosely: the album's id while the list stands. */
  key: string;
  title: string;
  artist: string;
  /** The artist's key (LocalArtist.key). */
  artistKey: string;
  /** 0 when unknown. */
  year: number;
  /** The first song's cover that has one ('' for none). */
  cover: string;
  songs: LocalSong[];
}

export interface LocalArtist {
  key: string;
  name: string;
  /** Newest first; those of unknown year last. */
  albums: LocalAlbum[];
  /** Every song of theirs, by title. */
  songs: LocalSong[];
}

export const UNKNOWN_ARTIST = 'Unknown artist';
export const UNKNOWN_ALBUM = 'Unknown album';
/** The Unknown album's key: no real album's (theirs hold a line break between name and artist). */
export const UNKNOWN_ALBUM_KEY = '\n';

/** Names as they match: case, accents' composed forms and spacing aside. */
export const looseKey = (s: string): string => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;

/** Whose song it is: the album artist, else the artist. */
const ownerOf = (s: LocalSong): string => s.albumArtist.trim() || s.artist;

/** The spelling most of [names] use (the first one seen when tied). */
function mostCommon(names: string[]): string {
  const counts = new Map<string, number>();
  let best = names[0] ?? '';
  for (const n of names) {
    const c = (counts.get(n) ?? 0) + 1;
    counts.set(n, c);
    if (c > (counts.get(best) ?? 0)) best = n;
  }
  return best;
}

/** An album's order: disc, then track (unnumbered after numbered), then title. */
function albumOrder(a: LocalSong, b: LocalSong): number {
  return (a.disc || 1) - (b.disc || 1) || (a.track || 10_000) - (b.track || 10_000) || byName(a.title, b.title);
}

export function groupLocal(songs: readonly LocalSong[]): { albums: LocalAlbum[]; artists: LocalArtist[] } {
  const albumSongs = new Map<string, LocalSong[]>();
  const artistSongs = new Map<string, LocalSong[]>();
  const noAlbum: LocalSong[] = [];
  for (const s of songs) {
    const owner = looseKey(ownerOf(s));
    artistSongs.set(owner, [...(artistSongs.get(owner) ?? []), s]);
    if (!s.album.trim()) {
      noAlbum.push(s);
      continue;
    }
    const key = looseKey(s.album) + '\n' + owner;
    albumSongs.set(key, [...(albumSongs.get(key) ?? []), s]);
  }
  const albums = [...albumSongs].map(([key, list]): LocalAlbum => {
    const ordered = [...list].sort(albumOrder);
    const withCover = ordered.find((s) => s.cover);
    return {
      key,
      title: mostCommon(list.map((s) => s.album.trim())),
      artist: mostCommon(list.map(ownerOf)),
      artistKey: looseKey(ownerOf(list[0]!)),
      year: ordered.find((s) => s.year)?.year ?? 0,
      cover: withCover ? localArtUrl(withCover.id) : '',
      songs: ordered,
    };
  });
  albums.sort((a, b) => byName(a.title, b.title) || byName(a.artist, b.artist));
  if (noAlbum.length) {
    const ordered = [...noAlbum].sort((a, b) => byName(a.title, b.title));
    const withCover = ordered.find((s) => s.cover);
    albums.push({ key: UNKNOWN_ALBUM_KEY, title: UNKNOWN_ALBUM, artist: '', artistKey: '', year: 0, cover: withCover ? localArtUrl(withCover.id) : '', songs: ordered });
  }
  const unknown = looseKey(UNKNOWN_ARTIST);
  const artists = [...artistSongs].map(([key, list]): LocalArtist => ({
    key,
    name: mostCommon(list.map(ownerOf)),
    albums: albums.filter((a) => a.key !== UNKNOWN_ALBUM_KEY && a.artistKey === key).sort((a, b) => (b.year || -1) - (a.year || -1) || byName(a.title, b.title)),
    songs: [...list].sort((a, b) => byName(a.title, b.title)),
  }));
  artists.sort((a, b) => Number(a.key === unknown) - Number(b.key === unknown) || byName(a.name, b.name));
  return { albums, artists };
}
