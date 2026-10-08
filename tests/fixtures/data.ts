/**
 * A synthetic Jukebox: about 720 posts shaped like Cyberspace's Firestore documents,
 * generated deterministically (same data every run, dated relative to now).
 *
 * Shaped like the real thing where tests depend on it: ~150 free-text genres with a
 * long tail (one with ~60 tracks; "pop", "electronic", digits, accents, non-Latin),
 * ~420 credited artists (some "X & Y", some "The …", accents, digits, a few "A, B"
 * credits), save counts with a long tail, NSFW posts, posts with two audio
 * attachments, and the rows the public query must never return: deleted, banned,
 * shadow-banned, members-only (isPublic false) and posts without audio.
 */

export const PROJECT_PATH = 'projects/cyberspace-cyberspace/databases/(default)/documents';

export const AUTH_USER = { email: 'nightowl@example.com', password: 'correct horse battery', username: 'nightowl', uid: 'fakeUid0001' };

/** Members-only posts, newer than every public post (newest first). */
export const MEMBERS_POSTS = [
  { id: 'membersPost001', title: 'Velvet Underground Hours', artist: 'Midnight Members', genre: 'synthwave', yt: 'Mbr00000001', by: 'nightowl' },
  { id: 'membersPost002', title: 'Secret Garden Tape', artist: 'Closed Circle', genre: 'ambient', yt: 'Mbr00000002', by: 'moth' },
  { id: 'membersPost003', title: 'Backroom Radio', artist: 'Midnight Members', genre: 'lo-fi', yt: 'Mbr00000003', by: 'nightowl' },
];
/** A public post by a banned author: only the members query returns it; the phone must hide it. */
export const BANNED_POST = { id: 'bannedPost001', title: 'Banned Broadcast', artist: 'Nobody', genre: 'noise', yt: 'Ban00000001', by: 'spammer' };

export type FsValue = Record<string, unknown>;

/** A genre set only on attachments, never as the post's audioAttachmentGenre. */
export const ATTACHMENT_ONLY_GENRE = 'tape loops';
export interface Doc {
  name: string;
  id: string;
  createdAt: string;
  fields: Record<string, FsValue>;
}

// ---- Deterministic randomness ------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AB = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function fakeYtId(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const r = mulberry32(h);
  let out = '';
  for (let i = 0; i < 11; i++) out += AB[Math.floor(r() * 64)];
  return out;
}

// ---- Vocabulary ----------------------------------------------------------------------------

const GENRE_BASE = [
  'electronic', 'synthwave', 'ambient', 'lo-fi', 'pop', 'rock', 'hip hop', 'jazz', 'house', 'techno', 'indie', 'metal',
  'punk', 'folk', 'soul', 'funk', 'disco', 'shoegaze', 'dream pop', 'vaporwave', 'chiptune', 'drum and bass', 'dubstep',
  'trip hop', 'post-rock', 'noise', 'industrial', 'darkwave', 'city pop', 'r&b', 'reggae', 'dub', 'blues', 'country',
  'classical', 'soundtrack', 'experimental', 'idm', 'breakcore', 'jungle', 'garage', 'grime', 'trance', 'downtempo',
  'chillwave', 'new wave', 'post-punk', 'emo', 'hardcore', 'grunge', 'bossa nova', 'afrobeat', 'k-pop', 'j-pop',
  'outrun', 'witch house', 'hyperpop', 'phonk', 'plunderphonics', 'minimal', 'acid', 'electro', 'italo disco',
  '80s', '90s', '2-step', 'émo revival', 'música popular', 'ポップ', 'электроника', 'zouk', 'gospel', 'ska',
];
const GENRE_MODS = ['dark', 'lofi', 'melodic', 'deep', 'cosmic', 'japanese', 'french', 'atmospheric', 'progressive', 'psychedelic', 'instrumental', 'bedroom'];

const ADJ = ['Neon', 'Velvet', 'Paper', 'Static', 'Glass', 'Golden', 'Silver', 'Hollow', 'Electric', 'Midnight', 'Crystal', 'Faded', 'Lunar', 'Solar',
  'Quiet', 'Broken', 'Pale', 'Wild', 'Distant', 'Neural', 'Analog', 'Digital', 'Northern', 'Southern', 'Violet', 'Amber', 'Cobalt', 'Scarlet'];
const NOUN = ['Harbor', 'Owls', 'Tapes', 'Rivers', 'Machines', 'Gardens', 'Ghosts', 'Satellites', 'Lights', 'Wolves', 'Echoes', 'Signals', 'Pilots',
  'Tides', 'Mirrors', 'Strangers', 'Engines', 'Dreamers', 'Waves', 'Circuits', 'Choir', 'Arcade', 'Cassettes', 'Lanterns'];
const FIRST = ['Mira', 'Jonas', 'Ada', 'Kenji', 'Lucía', 'Émile', 'Noor', 'Sven', 'Yara', 'Otis', 'Ines', 'Ravi', 'Zoë', 'Felix', 'Hana', 'Björn'];
const LAST = ['Vale', 'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Rossi', 'Kowalski', 'Haddad', 'Novak', 'Silva', 'Brandt', 'Quinn'];
const TITLE_A = ['Midnight', 'Neon', 'Paper', 'Static', 'Low', 'Glass', 'Satellite', 'Velvet', 'Echo', 'Northern', 'Slow', 'Daydream', 'Golden', 'Cassette',
  'Silver', 'Night', 'Blue', 'Electric', 'Lonely', 'Hidden', 'Falling', 'Endless', 'Burning', 'Frozen', 'Restless', 'Wandering'];
const TITLE_B = ['Drive', 'Rain', 'Moons', 'Hearts', 'Tide', 'Garden', 'Love', 'Static', 'Park', 'Lights', 'Burn', 'Radio', 'Hour', 'Summer', 'Lining',
  'Swim', 'City', 'Dreams', 'Signal', 'Highway', 'Letters', 'Shadows', 'Waves', 'Fever', 'Horizon', 'Avenue'];
const POSTERS = Array.from({ length: 60 }, (_, i) => ['cyberpunk', 'nightowl', 'moth', 'vapor', 'dial_up', 'crt_ghost', 'bitrate', 'sysop', 'modem', 'lurker'][i % 10] + (i >= 10 ? String(i) : ''));

// ---- Generation ----------------------------------------------------------------------------

function buildGenres(r: () => number): string[] {
  const out = [...GENRE_BASE];
  for (const m of GENRE_MODS) for (const g of GENRE_BASE.slice(0, 8)) if (out.length < 160) out.push(`${m} ${g}`);
  // Shuffle the tail so modifiers don't all sit together.
  const head = out.slice(0, 6);
  const tail = out.slice(6);
  for (let i = tail.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [tail[i], tail[j]] = [tail[j], tail[i]];
  }
  return [...head, ...tail];
}

function buildArtists(r: () => number): string[] {
  const set = new Set<string>();
  const out: string[] = [];
  const add = (n: string) => {
    const k = n.toLowerCase();
    if (!set.has(k)) {
      set.add(k);
      out.push(n);
    }
  };
  let i = 0;
  while (out.length < 420 && i < 5000) {
    const kind = i % 6;
    const a = ADJ[Math.floor(r() * ADJ.length)];
    const n = NOUN[Math.floor(r() * NOUN.length)];
    const f = FIRST[Math.floor(r() * FIRST.length)];
    const l = LAST[Math.floor(r() * LAST.length)];
    if (kind === 0) add(`The ${a} ${n}`);
    else if (kind === 1) add(`${a} ${n}`);
    else if (kind === 2) add(`${f} ${l}`);
    else if (kind === 3) add(`${f} & The ${n}`);
    else if (kind === 4) add(`${a}${n.toLowerCase()}`);
    else add(`${f} ${a}`);
    i++;
  }
  add('808 Machines');
  add('2Lunar');
  return out;
}

/** Index from a long-tailed distribution over n items (0 most likely). */
function zipf(r: () => number, n: number, s = 1.1): number {
  return Math.min(n - 1, Math.floor(Math.pow(r(), s * 2.2) * n));
}

const str = (v: string) => ({ stringValue: v });
const bool = (v: boolean) => ({ booleanValue: v });
const int = (v: number) => ({ integerValue: String(v) });
const ts = (v: string) => ({ timestampValue: v });

function audio(title: string, artist: string, genre: string, yt: string): FsValue {
  return {
    mapValue: {
      fields: {
        type: str('audio'),
        origin: str('youtube'),
        src: str(`https://www.youtube.com/watch?v=${yt}`),
        title: str(title),
        artist: str(artist),
        genre: str(genre),
      },
    },
  };
}

interface PostSpec {
  id: string;
  by: string;
  title: string;
  createdAt: string;
  genre: string;
  attachments: FsValue[];
  nsfw?: boolean;
  isPublic?: boolean;
  deleted?: boolean;
  banned?: boolean;
  shadow?: boolean;
  hasAudio?: boolean;
  saves?: number;
  replies?: number;
}

function doc(p: PostSpec): Doc {
  return {
    id: p.id,
    name: `${PROJECT_PATH}/posts/${p.id}`,
    createdAt: p.createdAt,
    fields: {
      authorUsername: str(p.by),
      slug: str(p.id.toLowerCase()),
      title: str(p.title),
      isNSFW: bool(!!p.nsfw),
      isPublic: bool(p.isPublic !== false),
      deleted: bool(!!p.deleted),
      isBanned: bool(!!p.banned),
      isShadowBanned: bool(!!p.shadow),
      hasAudioAttachment: bool(p.hasAudio !== false),
      createdAt: ts(p.createdAt),
      audioAttachmentGenre: str(p.genre),
      bookmarksCount: int(p.saves ?? 0),
      repliesCount: int(p.replies ?? 0),
      topics: { arrayValue: { values: [str('music')] } },
      attachments: { arrayValue: { values: p.attachments } },
    },
  };
}

export interface Dataset {
  docs: Doc[];
  genres: string[];
  artists: string[];
  /** The newest public post's createdAt. */
  newestPublic: string;
}

/** Build the dataset for a given "now" (hour-aligned, so parallel workers agree). */
export function buildDataset(now = Math.floor(Date.now() / 3_600_000) * 3_600_000): Dataset {
  const r = mulberry32(20261008);
  const genres = buildGenres(r);
  const artists = buildArtists(r);
  const docs: Doc[] = [];
  const DAY = 86_400_000;
  const N = 720;
  let t = now - 2 * 3_600_000; // the newest public post: two hours ago
  for (let i = 0; i < N; i++) {
    t -= Math.floor(r() * 0.6 * DAY) + 60_000;
    const createdAt = new Date(t).toISOString();
    const id = `post${String(i).padStart(4, '0')}`;
    // Every artist gets at least one post; after that the popular ones get more.
    const artist = i < artists.length ? artists[i] : artists[zipf(r, artists.length)];
    const genre = genres[zipf(r, genres.length, 1.35)];
    const title = `${TITLE_A[Math.floor(r() * TITLE_A.length)]} ${TITLE_B[Math.floor(r() * TITLE_B.length)]}${r() < 0.06 ? ' (Official Video)' : ''}`;
    const by = POSTERS[zipf(r, POSTERS.length)];
    const yt = fakeYtId(id);
    const roll = r();
    const credit = roll < 0.05 ? `${artist}, ${artists[zipf(r, artists.length)]}` : artist;
    const attachments = [audio(title, credit, genre, yt)];
    if (r() < 0.04) attachments.push(audio(`${title} (Reprise)`, artist, genre, fakeYtId(id + 'b')));
    if (r() < 0.05) attachments.unshift({ mapValue: { fields: { type: str('image'), src: str('https://example.com/x.png') } } });
    const saves = r() < 0.55 ? 0 : Math.floor(Math.pow(r(), 3) * 48) + 1;
    const special = r();
    docs.push(
      doc({
        id,
        by,
        title: r() < 0.3 ? `${title} — what a tune` : '',
        createdAt,
        genre,
        attachments,
        saves,
        replies: Math.floor(r() * 6),
        nsfw: r() < 0.04,
        isPublic: !(special < 0.03),
        deleted: special >= 0.03 && special < 0.05,
        banned: special >= 0.05 && special < 0.06,
        shadow: special >= 0.06 && special < 0.065,
      }),
    );
  }
  // A genre only on the attachments (the genre query can't see it; the app falls back
  // to the catalog): the third newest public post and a few older ones.
  const isPub = (d: Doc) => (d.fields.isPublic as { booleanValue: boolean }).booleanValue && !(d.fields.deleted as { booleanValue: boolean }).booleanValue && !(d.fields.isBanned as { booleanValue: boolean }).booleanValue && !(d.fields.isShadowBanned as { booleanValue: boolean }).booleanValue && !(d.fields.isNSFW as { booleanValue: boolean }).booleanValue;
  docs.filter(isPub).filter((_, k) => k === 2 || k === 40 || k === 90 || k === 200).forEach((d) => {
    d.fields.audioAttachmentGenre = str('');
    for (const a of (d.fields.attachments as { arrayValue: { values: { mapValue: { fields: Record<string, FsValue> } }[] } }).arrayValue.values)
      if (a.mapValue.fields.type && (a.mapValue.fields.type as { stringValue: string }).stringValue === 'audio') a.mapValue.fields.genre = str(ATTACHMENT_ONLY_GENRE);
  });
  const newestPublic = docs.find((d) => (d.fields.isPublic as { booleanValue: boolean }).booleanValue && !(d.fields.deleted as { booleanValue: boolean }).booleanValue && !(d.fields.isBanned as { booleanValue: boolean }).booleanValue)!.createdAt;
  // A post without audio (filtered by hasAudioAttachment).
  docs.push(doc({ id: 'textOnly001', by: 'lurker', title: 'Just words', createdAt: new Date(now - 3 * 3_600_000).toISOString(), genre: '', attachments: [], hasAudio: false }));
  // Members-only posts and a banned author's post, newer than every public post.
  MEMBERS_POSTS.forEach((p, i) =>
    docs.push(doc({ id: p.id, by: p.by, title: p.title, genre: p.genre, createdAt: new Date(now - 20 * 60_000 - i * 1000).toISOString(), attachments: [audio(p.title, p.artist, p.genre, p.yt)], isPublic: false })),
  );
  docs.push(
    doc({ id: BANNED_POST.id, by: BANNED_POST.by, title: BANNED_POST.title, genre: BANNED_POST.genre, createdAt: new Date(now - 20 * 60_000 - 500).toISOString(), attachments: [audio(BANNED_POST.title, BANNED_POST.artist, BANNED_POST.genre, BANNED_POST.yt)], banned: true }),
  );
  return { docs, genres, artists, newestPublic };
}
