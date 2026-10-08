/**
 * Runtime guards for data that crosses a trust boundary: the native bridge (player
 * state, music pages), Firestore responses, and lists read back from storage. Each
 * returns well-typed data or drops what doesn't fit; none of them throw.
 */
import type { Track, TrackOrigin } from '../data/model';
import type { FsDocument, FsRunQueryRow } from '../data/model';
import type { NativeState, RepeatMode } from '../player/native';
import type { MusicItem, MusicPage } from '../data/ytmusic';

export function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const isStr = (x: unknown): x is string => typeof x === 'string';
const finite = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter(isStr) : []);

export const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const REPEAT: readonly RepeatMode[] = ['off', 'all', 'one'];

// ---- Native bridge ---------------------------------------------------------------------

/**
 * A `state` event (or getState() result) from the JukePlayer plugin. `prevQueueIds` is
 * used when the event says the list didn't change (`queueIdsUnchanged`, no
 * `queueIds`). `upNextKinds` always comes back with one letter per upNext id. Null when
 * it isn't a state object at all.
 */
export function parseNativeState(x: unknown, prevQueueIds: readonly string[] = []): NativeState | null {
  if (!isObj(x)) return null;
  const unchanged = x.queueIdsUnchanged === true && !Array.isArray(x.queueIds);
  const queueIds = unchanged ? prevQueueIds.slice() : strings(x.queueIds);
  const index = typeof x.index === 'number' && Number.isInteger(x.index) && x.index >= -1 && x.index < queueIds.length ? x.index : -1;
  const upNextIds = strings(x.upNextIds).slice(0, 50);
  const kinds = isStr(x.upNextKinds) ? x.upNextKinds : '';
  const ctx = isObj(x.context) ? x.context : null;
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
    context: ctx ? { label: isStr(ctx.label) ? ctx.label : '', mode: ctx.mode === 'radio' ? 'radio' : 'list' } : null,
    seedId: isStr(x.seedId) && x.seedId ? x.seedId : null,
  };
}

const KINDS: readonly MusicItem['kind'][] = ['song', 'album', 'artist', 'playlist'];

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
  if (isStr(x.thumbnailUrl) && /^https:\/\//.test(x.thumbnailUrl)) item.thumbnailUrl = x.thumbnailUrl;
  const n = finite(x.itemCount);
  if (n !== undefined && n >= 0) item.itemCount = n;
  if (isStr(x.artistUrl)) item.artistUrl = x.artistUrl;
  if (isStr(x.channelId)) item.channelId = x.channelId;
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
      if (isStr(d.updateTime)) doc.updateTime = d.updateTime;
      row.document = doc;
    }
    if (isStr(r.readTime)) row.readTime = r.readTime;
    if (r.done === true) row.done = true;
    out.push(row);
  }
  return out;
}

// ---- Stored tracks ---------------------------------------------------------------------

const ORIGINS: readonly TrackOrigin[] = ['jukebox', 'ytmusic'];
const TRACK_STRINGS = ['id', 'ytId', 'title', 'artist', 'genre', 'by', 'postTitle', 'postUrl', 'createdAt', 'artworkUrl'] as const;

/** Every field of a Track present and of the right type (optional ones when set). */
export function isTrackFull(x: unknown): x is Track {
  if (!isObj(x)) return false;
  for (const k of TRACK_STRINGS) if (!isStr(x[k])) return false;
  if (!x.id || !YT_ID_RE.test(x.ytId as string) || typeof x.nsfw !== 'boolean') return false;
  if (x.saves !== undefined && finite(x.saves) === undefined) return false;
  if (x.replies !== undefined && finite(x.replies) === undefined) return false;
  if (x.source !== undefined && !ORIGINS.includes(x.source as TrackOrigin)) return false;
  if (x.membersOnly !== undefined && typeof x.membersOnly !== 'boolean') return false;
  return true;
}

/**
 * A stored track, repaired: missing text fields become '' and `nsfw` false, so lists
 * saved by older versions survive. Null without an id, a valid video id and a title.
 */
export function asTrack(x: unknown): Track | null {
  if (!isObj(x) || !isStr(x.id) || !x.id || !isStr(x.ytId) || !YT_ID_RE.test(x.ytId) || !isStr(x.title)) return null;
  const t: Track = {
    id: x.id,
    ytId: x.ytId,
    title: x.title,
    artist: isStr(x.artist) ? x.artist : '',
    genre: isStr(x.genre) ? x.genre : '',
    by: isStr(x.by) ? x.by : '',
    postTitle: isStr(x.postTitle) ? x.postTitle : '',
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
