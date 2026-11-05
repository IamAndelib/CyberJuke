/**
 * Runtime guards for data that crosses a trust boundary: the native bridge (player
 * state, music pages), Firestore responses, and lists read back from storage. Each
 * returns well-typed data or drops what doesn't fit; none of them throw.
 */
import type { FsDocument, FsRunQueryRow, Track, TrackArtist, TrackOrigin } from '../data/model';
import type { NativeState, RepeatMode } from '../player/native';
import type { MusicItem, MusicPage } from '../data/ytmusic';
import type { LocalFolder, LocalFolderState, LocalSong } from '../data/local';
import { tidy } from './text';

export function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const isStr = (x: unknown): x is string => typeof x === 'string';
const finite = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter(isStr) : []);

export const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * A Jukebox MP3: a public latex.gg share link, the only kind the site accepts (its own
 * validator, Cyberspace 4.0). Nothing else is ever handed to the player as a URL.
 */
export const MP3_URL_RE = /^https:\/\/latex\.gg\/share\/[A-Za-z0-9_-]+\.mp3$/i;
export const isMp3Url = (x: unknown): x is string => isStr(x) && MP3_URL_RE.test(x);

/** A local song's id (data/local): `loc:` and 16 hex. */
export const LOCAL_ID_RE = /^loc:[0-9a-f]{16}$/;

/** A song from a folder on the phone, by its id and origin. */
export const isLocalTrack = (t: Partial<Pick<Track, 'id' | 'source'>> | null | undefined): boolean => !!t && t.source === 'local' && isStr(t.id) && LOCAL_ID_RE.test(t.id);

/** A track the player can load: a YouTube video id, a Jukebox MP3 or a local song (placeholders have none). */
export function hasAudio(t: (Pick<Track, 'ytId' | 'mp3'> & Partial<Pick<Track, 'id' | 'source'>>) | null | undefined): boolean {
  return !!t && (YT_ID_RE.test(t.ytId) || isMp3Url(t.mp3) || isLocalTrack(t));
}

/** A Jukebox MP3's audio id: `mp3:` and its latex.gg file name (the prefix as written, the file as MP3_URL_RE takes it). */
const MP3_AUDIO_ID_RE = /^mp3:[A-Za-z0-9_-]+\.[Mm][Pp]3$/;

/**
 * What the native listening cache knows a track's audio by (SessionPolicy.isValidAudioId): a
 * video id, or `mp3:<file>` for a Jukebox MP3. Liked, the saved set and the bridge carry these.
 */
export const isAudioId = (x: unknown): x is string => isStr(x) && (YT_ID_RE.test(x) || MP3_AUDIO_ID_RE.test(x));

/**
 * A track's audio id (isAudioId): its video id, else `mp3:<file>` of its MP3 link (as native
 * builds it from the same file name), else '' (a placeholder: nothing to cache).
 */
export function audioIdOf(t: Pick<Track, 'ytId' | 'mp3'> | null | undefined): string {
  if (!t) return '';
  if (YT_ID_RE.test(t.ytId)) return t.ytId;
  return isMp3Url(t.mp3) ? `mp3:${t.mp3.slice(t.mp3.lastIndexOf('/') + 1)}` : '';
}

/** Up next lists at most this many tracks (native sends as many: StateEncoder.MAX_UP_NEXT). */
export const UP_NEXT_MAX = 50;

/** An https URL (what the app loads images and links from). */
export const isHttpsUrl = (x: unknown): x is string => isStr(x) && x.startsWith('https://');
const REPEAT: readonly RepeatMode[] = ['off', 'all', 'one'];

// ---- Native bridge ---------------------------------------------------------------------

/**
 * A `state` event (or getState() result) from the JukePlayer plugin. `prevQueueIds` is
 * used when the event says the list didn't change (`queueIdsUnchanged`, no
 * `queueIds`). `upNextKinds` always comes back with one letter per upNext id, and
 * `upNextIndex` with one list index per upNext id (-1 when native sent none, or one
 * that doesn't hold that id). Null when it isn't a state object at all.
 */
export function parseNativeState(x: unknown, prevQueueIds: readonly string[] = []): NativeState | null {
  if (!isObj(x)) return null;
  const unchanged = x.queueIdsUnchanged === true && !Array.isArray(x.queueIds);
  const queueIds = unchanged ? prevQueueIds.slice() : strings(x.queueIds);
  const index = typeof x.index === 'number' && Number.isInteger(x.index) && x.index >= -1 && x.index < queueIds.length ? x.index : -1;
  const upNextIds = strings(x.upNextIds).slice(0, UP_NEXT_MAX);
  const kinds = isStr(x.upNextKinds) ? x.upNextKinds : '';
  // K1: one list index per upNext id; -1 where it's missing or doesn't fit (the id is then looked up).
  const rawIndex = Array.isArray(x.upNextIndex) ? x.upNextIndex : [];
  const upNextIndex = upNextIds.map((id, k) => {
    const i = rawIndex[k];
    return typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < queueIds.length && queueIds[i] === id ? i : -1;
  });
  const ctx = isObj(x.context) ? x.context : null;
  const prevIndex = (Array.isArray(x.prevIndex) ? x.prevIndex : [])
    .filter((i): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < queueIds.length && i !== index)
    .slice(-UP_NEXT_MAX);
  const at = (v: unknown, none: number) => (typeof v === 'number' && Number.isInteger(v) && v >= none && v < queueIds.length ? v : none);
  return {
    isPlaying: x.isPlaying === true,
    isBuffering: x.isBuffering === true,
    index,
    trackId: isStr(x.trackId) ? x.trackId : null,
    positionMs: Math.max(0, finite(x.positionMs) ?? 0),
    durationMs: Math.max(0, finite(x.durationMs) ?? 0),
    shuffle: x.shuffle === true,
    repeat: REPEAT.includes(x.repeat as RepeatMode) ? (x.repeat as RepeatMode) : 'off',
    queueIds,
    upNextIds,
    // One of q/l/a per upNext entry; anything missing or unknown is the list.
    upNextKinds: upNextIds.map((_, i) => (kinds[i] === 'q' || kinds[i] === 'a' ? kinds[i] : 'l')).join(''),
    upNextIndex,
    prevIndex,
    listStart: at(x.listStart, 0),
    nextStart: at(x.nextStart, -1),
    context: ctx ? { label: isStr(ctx.label) ? ctx.label : '', mode: ctx.mode === 'radio' ? 'radio' : 'list' } : null,
    seedId: isStr(x.seedId) && x.seedId ? x.seedId : null,
    currentAuto: x.currentAuto === true,
    waitingForNetwork: x.waitingForNetwork === true,
    bufferedAheadMs: Math.max(0, finite(x.bufferedAheadMs) ?? 0),
  };
}

const KINDS: readonly MusicItem['kind'][] = ['song', 'album', 'artist', 'playlist'];

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{10,}$/;
/** Most credited artists a track keeps (as native does). */
const MAX_ARTISTS = 10;

/** A song's credited artists (MusicItem / Track / NativeTrack `artists`): each a name and a channel id, else dropped. */
export function parseTrackArtists(x: unknown): TrackArtist[] {
  if (!Array.isArray(x)) return [];
  const out: TrackArtist[] = [];
  for (const a of x) {
    if (!isObj(a) || !isStr(a.name) || !a.name.trim() || !isStr(a.channelId) || !CHANNEL_ID_RE.test(a.channelId)) continue;
    out.push({ name: a.name.trim(), channelId: a.channelId });
    if (out.length === MAX_ARTISTS) break;
  }
  return out;
}

/** One search/album/artist item from JukeMusic, or null when it's unusable. */
export function parseMusicItem(x: unknown): MusicItem | null {
  if (!isObj(x) || !KINDS.includes(x.kind as MusicItem['kind']) || !isStr(x.url) || !x.url) return null;
  const item: MusicItem = {
    kind: x.kind as MusicItem['kind'],
    title: isStr(x.title) ? x.title : '',
    subtitle: isStr(x.subtitle) ? x.subtitle : '',
    url: x.url,
  };
  if (isStr(x.ytId) && YT_ID_RE.test(x.ytId)) item.ytId = x.ytId;
  const dur = finite(x.durationSec);
  if (dur !== undefined && dur >= 0) item.durationSec = dur;
  if (isHttpsUrl(x.thumbnailUrl)) item.thumbnailUrl = x.thumbnailUrl;
  const n = finite(x.itemCount);
  if (n !== undefined && n >= 0) item.itemCount = n;
  if (isStr(x.artistUrl)) item.artistUrl = x.artistUrl;
  if (isStr(x.channelId)) item.channelId = x.channelId;
  const artists = parseTrackArtists(x.artists);
  if (artists.length) item.artists = artists;
  return item;
}

export function parseMusicItems(x: unknown): MusicItem[] {
  if (!Array.isArray(x)) return [];
  const out: MusicItem[] = [];
  for (const it of x) {
    const m = parseMusicItem(it);
    if (m) out.push(m);
  }
  return out;
}

/** A page of items with an optional opaque paging token. */
export function parseMusicPage(x: unknown): MusicPage {
  const o = isObj(x) ? x : {};
  const page: MusicPage = { items: parseMusicItems(o.items) };
  if (isStr(o.next) && o.next) page.next = o.next;
  return page;
}

// ---- Firestore --------------------------------------------------------------------------

/** A runQuery response: rows whose `document` isn't a named document lose it. */
export function parseRunQueryRows(x: unknown): FsRunQueryRow[] | null {
  if (!Array.isArray(x)) return null;
  const out: FsRunQueryRow[] = [];
  for (const r of x) {
    if (!isObj(r)) continue;
    const row: FsRunQueryRow = {};
    const d = r.document;
    if (isObj(d) && isStr(d.name) && (d.fields === undefined || isObj(d.fields))) {
      const doc: FsDocument = { name: d.name };
      if (isObj(d.fields)) doc.fields = d.fields as FsDocument['fields'];
      if (isStr(d.createTime)) doc.createTime = d.createTime;
      row.document = doc;
    }
    out.push(row);
  }
  return out;
}

// ---- Stored tracks ---------------------------------------------------------------------

const ORIGINS: readonly TrackOrigin[] = ['jukebox', 'ytmusic', 'signal', 'local'];
const TRACK_STRINGS = ['id', 'ytId', 'title', 'artist', 'genre', 'by', 'postTitle', 'postUrl', 'createdAt', 'artworkUrl'] as const;

/** Every field of a Track present and of the right type (optional ones when set). */
export function isTrackFull(x: unknown): x is Track {
  if (!isObj(x)) return false;
  for (const k of TRACK_STRINGS) if (!isStr(x[k])) return false;
  if (x.mp3 !== undefined && !isMp3Url(x.mp3)) return false;
  if (x.ytId !== '' && !YT_ID_RE.test(x.ytId as string)) return false;
  // An MP3 has no video id (Track.mp3): never both.
  if (x.mp3 !== undefined && x.ytId !== '') return false;
  if (!x.id || !hasAudio(x as Pick<Track, 'ytId' | 'mp3' | 'id' | 'source'>) || typeof x.nsfw !== 'boolean') return false;
  if (x.saves !== undefined && finite(x.saves) === undefined) return false;
  if (x.replies !== undefined && finite(x.replies) === undefined) return false;
  if (x.source !== undefined && !ORIGINS.includes(x.source as TrackOrigin)) return false;
  if (x.membersOnly !== undefined && typeof x.membersOnly !== 'boolean') return false;
  return true;
}

/**
 * A stored track, repaired: missing text fields become '' and `nsfw` false, so lists
 * saved by older versions survive. Null without an id, a title and something to play
 * (a valid video id or a Jukebox MP3 link).
 */
export function asTrack(x: unknown): Track | null {
  if (!isObj(x) || !isStr(x.id) || !x.id || !isStr(x.title)) return null;
  const ytId = isStr(x.ytId) && YT_ID_RE.test(x.ytId) ? x.ytId : '';
  // An MP3 has no video id (Track.mp3): a video id wins.
  const mp3 = !ytId && isMp3Url(x.mp3) ? x.mp3 : undefined;
  if (!ytId && !mp3 && !isLocalTrack(x as Partial<Track>)) return null;
  const t: Track = {
    id: x.id,
    ytId,
    ...(mp3 && { mp3 }),
    title: tidy(x.title),
    artist: isStr(x.artist) ? tidy(x.artist) : '',
    genre: isStr(x.genre) ? tidy(x.genre) : '',
    by: isStr(x.by) ? tidy(x.by) : '',
    postTitle: isStr(x.postTitle) ? tidy(x.postTitle) : '',
    postUrl: isStr(x.postUrl) ? x.postUrl : '',
    createdAt: isStr(x.createdAt) ? x.createdAt : '',
    nsfw: x.nsfw === true,
    artworkUrl: isStr(x.artworkUrl) ? x.artworkUrl : '',
  };
  const saves = finite(x.saves);
  if (saves !== undefined) t.saves = saves;
  const replies = finite(x.replies);
  if (replies !== undefined) t.replies = replies;
  if (ORIGINS.includes(x.source as TrackOrigin)) t.source = x.source as TrackOrigin;
  if (x.membersOnly === true) t.membersOnly = true;
  const album = isStr(x.album) ? tidy(x.album) : '';
  if (album) t.album = album;
  const artists = parseTrackArtists(x.artists);
  if (artists.length) t.artists = artists;
  return t;
}

/** A stored list of tracks: repaired, invalid ones dropped. */
export function asTracks(x: unknown): Track[] {
  if (!Array.isArray(x)) return [];
  const out: Track[] = [];
  for (const it of x) {
    const t = asTrack(it);
    if (t) out.push(t);
  }
  return out;
}

// ---- Local music (data/local) ------------------------------------------------------------

const FOLDER_STATES: readonly LocalFolderState[] = ['ok', 'scanning', 'gone'];

/** The chosen folders, as JukeLocal reports them; unusable ones dropped. */
export function parseLocalFolders(x: unknown): LocalFolder[] {
  const list = isObj(x) && Array.isArray(x.folders) ? x.folders : [];
  const out: LocalFolder[] = [];
  for (const f of list) {
    if (!isObj(f) || !isStr(f.id) || !f.id) continue;
    out.push({
      id: f.id,
      name: isStr(f.name) && f.name ? f.name : 'Folder',
      songs: Math.max(0, Math.trunc(finite(f.songs) ?? 0)),
      state: FOLDER_STATES.includes(f.state as LocalFolderState) ? (f.state as LocalFolderState) : 'ok',
    });
  }
  return out;
}

/** The songs in them; one without a well-formed id or folder is dropped. */
/** A track, disc or year tag's number: a whole number above 0, else 0 (unknown). */
const count = (x: unknown): number => (typeof x === 'number' && Number.isInteger(x) && x > 0 && x < 10_000 ? x : 0);

export function parseLocalSongs(x: unknown): LocalSong[] {
  const list = isObj(x) && Array.isArray(x.tracks) ? x.tracks : [];
  const out: LocalSong[] = [];
  for (const t of list) {
    if (!isObj(t) || !isStr(t.id) || !LOCAL_ID_RE.test(t.id) || !isStr(t.folder) || !t.folder) continue;
    out.push({
      id: t.id,
      title: (isStr(t.title) && tidy(t.title)) || 'Untitled',
      artist: (isStr(t.artist) && tidy(t.artist)) || 'Unknown artist',
      album: isStr(t.album) ? tidy(t.album) : '',
      albumArtist: isStr(t.albumArtist) ? tidy(t.albumArtist) : '',
      track: count(t.track),
      disc: count(t.disc),
      year: count(t.year),
      durationMs: Math.max(0, finite(t.durationMs) ?? 0),
      modified: Math.max(0, finite(t.modified) ?? 0),
      folder: t.folder,
      cover: t.cover === true,
    });
  }
  return out;
}
