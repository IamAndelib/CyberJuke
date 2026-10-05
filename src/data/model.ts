/**
 * Track model and parsing of Firestore REST documents into Tracks.
 * Pure functions only: no network, no globals. Unit-tested against
 * real fixtures in __fixtures__/runquery-sample.json.
 */

export interface Track {
  /** Firestore doc id, plus `-<attachmentIndex>` when the post has several audio attachments. */
  id: string;
  ytId: string;
  title: string;
  artist: string;
  /** Free-text genre as entered by the poster (trimmed); '' when missing. */
  genre: string;
  /** Username of the poster. */
  by: string;
  postTitle: string;
  postUrl: string;
  /** ISO timestamp of the post. */
  createdAt: string;
  nsfw: boolean;
  artworkUrl: string;
}

export const SITE_ORIGIN = 'https://beta.cyberspace.online';

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(['youtube.com', 'youtube-nocookie.com', 'youtu.be']);
const PATH_PREFIXES = new Set(['live', 'shorts', 'embed', 'v', 'e']);

/**
 * Extract the 11-char YouTube video id from any of the URL shapes posters use.
 * Returns null for anything that is not a recognisable YouTube video URL.
 */
export function parseYouTubeId(src: string | null | undefined): string | null {
  if (!src) return null;
  let raw = src.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (raw.startsWith('//')) raw = 'https:' + raw;
    else raw = 'https://' + raw;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  if (!YT_HOSTS.has(host)) return null;

  const segs = url.pathname.split('/').filter(Boolean);
  let candidate: string | null | undefined = null;
  if (host === 'youtu.be') {
    candidate = segs[0];
  } else if (segs[0] === 'watch' || segs.length === 0) {
    candidate = url.searchParams.get('v');
  } else if (PATH_PREFIXES.has(segs[0])) {
    candidate = segs[1];
  }
  if (!candidate) return null;
  // Tolerate stray junk glued to the id (e.g. "ID&t=1" inside a path segment).
  const m = /^[A-Za-z0-9_-]{11}/.exec(candidate);
  if (!m) return null;
  const id = m[0];
  // If the segment was longer, the next char must be a separator, not more id chars.
  if (candidate.length > 11 && /[A-Za-z0-9_-]/.test(candidate[11])) return null;
  return YT_ID.test(id) ? id : null;
}

export function artworkUrl(ytId: string): string {
  return `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`;
}

export function postUrl(username: string, slug: string): string {
  return `${SITE_ORIGIN}/${encodeURIComponent(username)}/${encodeURIComponent(slug)}`;
}

// ---- Firestore REST value decoding -------------------------------------------------

/** A Firestore REST `Value`. Only the shapes we read are typed. */
export type FsValue =
  | { stringValue: string }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { referenceValue: string }
  | { nullValue: null }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

export interface FsDocument {
  name: string;
  fields?: Record<string, FsValue>;
  createTime?: string;
  updateTime?: string;
}

export interface FsRunQueryRow {
  document?: FsDocument;
  readTime?: string;
  skippedResults?: number;
  done?: boolean;
}

export function str(v: FsValue | undefined): string {
  if (v && 'stringValue' in v && typeof v.stringValue === 'string') return v.stringValue;
  return '';
}

export function bool(v: FsValue | undefined): boolean {
  return !!(v && 'booleanValue' in v && v.booleanValue === true);
}

export function ts(v: FsValue | undefined): string {
  if (v && 'timestampValue' in v && typeof v.timestampValue === 'string') return v.timestampValue;
  return '';
}

export function docId(name: string): string {
  const i = name.lastIndexOf('/');
  return i >= 0 ? name.slice(i + 1) : name;
}

function mapFields(v: FsValue | undefined): Record<string, FsValue> | null {
  if (v && 'mapValue' in v) return v.mapValue.fields ?? {};
  return null;
}

function arrayValues(v: FsValue | undefined): FsValue[] {
  if (v && 'arrayValue' in v) return v.arrayValue.values ?? [];
  return [];
}

/** Turn one post document into zero or more Tracks (one per playable YouTube audio attachment). */
export function tracksFromDocument(doc: FsDocument): Track[] {
  const f = doc.fields ?? {};
  const id = docId(doc.name);
  const by = str(f.authorUsername);
  const slug = str(f.slug);
  const createdAt = ts(f.createdAt) || doc.createTime || '';
  const nsfw = bool(f.isNSFW);
  const postTitle = str(f.title).trim();
  const url = by && slug ? postUrl(by, slug) : SITE_ORIGIN + '/jukebox';

  const audio: { index: number; fields: Record<string, FsValue> }[] = [];
  arrayValues(f.attachments).forEach((a, index) => {
    const fields = mapFields(a);
    if (!fields) return;
    if (str(fields.type) !== 'audio') return;
    audio.push({ index, fields });
  });

  const out: Track[] = [];
  for (const { index, fields } of audio) {
    const origin = str(fields.origin);
    if (origin && origin !== 'youtube') continue;
    const ytId = parseYouTubeId(str(fields.src));
    if (!ytId) continue;
    out.push({
      id: audio.length > 1 ? `${id}-${index}` : id,
      ytId,
      title: str(fields.title).trim() || 'Untitled',
      artist: str(fields.artist).trim() || 'Unknown artist',
      genre: (str(fields.genre) || str(f.audioAttachmentGenre)).trim(),
      by,
      postTitle,
      postUrl: url,
      createdAt,
      nsfw,
      artworkUrl: artworkUrl(ytId),
    });
  }
  return out;
}

export function tracksFromRows(rows: FsRunQueryRow[]): Track[] {
  const out: Track[] = [];
  for (const r of rows) if (r.document) out.push(...tracksFromDocument(r.document));
  return out;
}
