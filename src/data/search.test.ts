import { describe, expect, it } from 'vitest';
import type { Track } from './model';
import { buildIndex, editDistance, matchWord, mergeTracks, normalize, searchGenres, searchTitles, searchTracks, words } from './search';

let n = 0;
function t(p: Partial<Track>): Track {
  n++;
  return {
    id: p.id ?? `t${n}`,
    ytId: 'abcdefghijk',
    title: 'Untitled',
    artist: 'Unknown artist',
    genre: '',
    by: 'someone',
    postTitle: '',
    postUrl: '',
    createdAt: `2026-01-${String(10 + (n % 20)).padStart(2, '0')}T00:00:00.000Z`,
    nsfw: false,
    artworkUrl: '',
    ...p,
  };
}

const CATALOG: Track[] = [
  t({ id: 'uematsu', title: 'To Zanarkand', artist: 'Nobuo Uematsu', genre: 'video game music', by: 'chocobo', createdAt: '2026-03-01T00:00:00Z' }),
  t({ id: 'trooper', title: 'The Trooper', artist: 'Iron Maiden', genre: 'heavy metal', by: 'eddie', createdAt: '2026-03-02T00:00:00Z' }),
  t({ id: 'metallica', title: 'Orion', artist: 'Metallica', genre: 'thrash metal', by: 'kirk', createdAt: '2026-03-03T00:00:00Z' }),
  t({ id: 'newwave', title: 'Love Will Tear Us Apart', artist: 'Joy Division', genre: 'new wave', by: 'ian', createdAt: '2026-03-04T00:00:00Z' }),
  // Newer than 'newwave', so only the score can put 'newwave' first.
  t({ id: 'duskwave', title: 'Neon Nights', artist: 'Duskwave', genre: 'synth', by: 'retro', createdAt: '2026-03-20T00:00:00Z' }),
  t({ id: 'soul', title: 'Ain’t No Sunshine', artist: 'Bill Withers', genre: 'soul', by: 'groove', createdAt: '2026-03-05T00:00:00Z' }),
  t({ id: 'soup', title: 'Alphabet Soup', artist: 'Kitchen Band', genre: 'novelty', by: 'chef', createdAt: '2026-03-06T00:00:00Z' }),
  t({ id: 'beyonce', title: 'Halo', artist: 'Beyoncé', genre: 'r&b', by: 'kaguya', createdAt: '2026-03-07T00:00:00Z' }),
  t({ id: 'acdc', title: 'Thunderstruck', artist: 'AC/DC', genre: 'hard rock', by: 'angus', createdAt: '2026-03-08T00:00:00Z' }),
  t({ id: 'citypop', title: 'Gentle Breeze', artist: 'Hiroshi Sato', genre: 'city pop', by: 'centipede', createdAt: '2026-03-09T00:00:00Z' }),
  t({ id: 'citypop2', title: 'Plastic Love', artist: 'Mariya Takeuchi', genre: 'city pop', by: 'kaguya', createdAt: '2026-03-10T00:00:00Z' }),
  t({ id: 'darklord', title: 'Dark Lord', artist: 'Someone', genre: 'ambient', by: 'x', createdAt: '2026-03-11T00:00:00Z' }),
  t({ id: 'darkthrone', title: 'Transilvanian Hunger', artist: 'Darkthrone', genre: 'black metal', by: 'y', createdAt: '2026-03-12T00:00:00Z' }),
  t({ id: 'postdark', title: 'Something Else', artist: 'Band', genre: 'pop', by: 'z', postTitle: 'listening in the dark', createdAt: '2026-03-25T00:00:00Z' }),
];
const INDEX = buildIndex(CATALOG);
const ids = (q: string) => searchTracks(INDEX, q).map((x) => x.id);

describe('normalize', () => {
  it('strips accents, lowercases and turns punctuation into spaces', () => {
    expect(normalize('Beyoncé')).toBe('beyonce');
    expect(normalize('@kaguya')).toBe('kaguya');
    expect(normalize('AC/DC')).toBe('ac dc');
    expect(normalize('  Sigur Rós — Hoppípolla!! ')).toBe('sigur ros hoppipolla');
    expect(normalize('Motörhead')).toBe('motorhead');
    expect(normalize('Straße Øresund')).toBe('strasse oresund');
    expect(normalize('ＦＵＬＬＷＩＤＴＨ')).toBe('fullwidth');
    expect(normalize('Ain’t')).toBe('ain t');
  });

  it('keeps non-Latin letters and digits', () => {
    expect(normalize('坂本龍一 1984')).toBe('坂本龍一 1984');
    expect(words('Кино - Группа крови')).toEqual(['кино', 'группа', 'крови']);
  });

  it('splits into words and handles empty input', () => {
    expect(words('  ')).toEqual([]);
    expect(words('...')).toEqual([]);
    expect(words('city-pop')).toEqual(['city', 'pop']);
  });
});

describe('editDistance', () => {
  it('counts a swap of two letters as one edit', () => {
    expect(editDistance('metlalica', 'metallica')).toBe(1);
    expect(editDistance('uematsy', 'uematsu')).toBe(1);
    expect(editDistance('maidn', 'maiden')).toBe(1);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('stops early beyond the cap', () => {
    expect(editDistance('aaaaaaaa', 'bbbbbbbb', 2)).toBe(3);
    expect(editDistance('a', 'abcdef', 1)).toBe(2);
  });
});

describe('matchWord', () => {
  it('scores exact, prefix, infix and typo matches', () => {
    expect(matchWord('rock', 'rock')).toBe(1);
    expect(matchWord('nobu', 'nobuo')).toBe(0.9);
    expect(matchWord('wave', 'synthwave')).toBe(0.6);
    expect(matchWord('metalica', 'metallica')).toBe(0.5);
    expect(matchWord('uematsy', 'uematsu')).toBe(0.5);
  });

  it('allows infix only for 3+ letters', () => {
    expect(matchWord('av', 'wave')).toBe(0);
    expect(matchWord('ave', 'wave')).toBe(0.6);
  });

  it('never typo-matches words of 1-4 letters', () => {
    expect(matchWord('soul', 'soup')).toBe(0);
    expect(matchWord('punk', 'funk')).toBe(0);
    expect(matchWord('pop', 'top')).toBe(0);
  });

  it('allows one typo for 5-7 letters and two for 8+', () => {
    expect(matchWord('maidn', 'maiden')).toBe(0.5);
    expect(matchWord('mxidn', 'maiden')).toBe(0);
    expect(matchWord('metlaica', 'metallica')).toBe(0.5); // 8 letters, 2 edits
    expect(matchWord('mtelaica', 'metallica')).toBe(0);
  });

  it('compares a typo against the same-length start of a longer word', () => {
    expect(matchWord('zanarq', 'zanarkand')).toBe(0.5);
    expect(matchWord('zanrk', 'zanarkand')).toBe(0); // two edits from "zanar"
  });
});

describe('searchTracks', () => {
  it('returns nothing for an empty or punctuation-only query', () => {
    expect(searchTracks(INDEX, '')).toEqual([]);
    expect(searchTracks(INDEX, '  !! ')).toEqual([]);
  });

  it('finds Nobuo Uematsu while typing and with a typo', () => {
    for (const q of ['uematsu', 'uemats', 'uematsy', 'nobu', 'Nobuo Uematsu']) expect(ids(q)[0]).toBe('uematsu');
  });

  it('finds Iron Maiden with a typo in the second word', () => {
    expect(ids('iron maidn')[0]).toBe('trooper');
    expect(ids('iron maidn')).toEqual(['trooper']);
  });

  it('finds Metallica with a missing letter', () => {
    expect(ids('metalica')[0]).toBe('metallica');
  });

  it('ranks the "new wave" genre above "wave" inside Duskwave', () => {
    const r = ids('wave');
    expect(r.slice(0, 2)).toEqual(['newwave', 'duskwave']);
  });

  it('does not typo-match "soul" to "soup"', () => {
    expect(ids('soul')).toEqual(['soul']);
    expect(ids('soup')).toEqual(['soup']);
  });

  it('matches accents and punctuation both ways', () => {
    expect(ids('beyonce')).toEqual(['beyonce']);
    expect(ids('BEYONCÉ')).toEqual(['beyonce']);
    expect(ids('ac/dc')[0]).toBe('acdc');
    expect(ids('ac dc')[0]).toBe('acdc');
    expect(ids('@kaguya')).toEqual([]); // a poster's name, not music
    expect(ids('aint no sunshine')).toEqual([]); // "ain t" splits; "aint" is not a typo target (4 letters)
    expect(ids('ain’t no sunshine')).toEqual(['soul']);
  });

  it('requires every query word to match (AND)', () => {
    expect(ids('city pop').sort()).toEqual(['citypop', 'citypop2']);
    // A poster's name is no search term (only the music counts).
    expect(ids('@centipede city pop')).toEqual([]);
    expect(ids('iron metallica')).toEqual([]);
  });

  it('ranks a title phrase first, then artists', () => {
    const r = ids('dark');
    expect(r[0]).toBe('darklord'); // title word + phrase bonus
    expect(r).toContain('darkthrone');
  });

  it('finds the music only: not who posted it, nor the post caption', () => {
    // "dark" only in the caption of postdark; "centipede", "eddie" only as posters.
    expect(ids('dark')).not.toContain('postdark');
    expect(ids('listening')).toEqual([]);
    expect(ids('eddie')).toEqual([]);
    expect(ids('centipede')).toEqual([]);
    // The same word in a title or artist still finds that track.
    const named = t({ id: 'named', title: 'Eddie', artist: 'Someone', by: 'z' });
    expect(searchTracks(buildIndex([...CATALOG, named]), 'eddie').map((x) => x.id)).toEqual(['named']);
  });

  it('breaks ties by newest post', () => {
    const a = t({ id: 'old', title: 'Same Song', createdAt: '2026-01-01T00:00:00Z' });
    const b = t({ id: 'new', title: 'Same Song', createdAt: '2026-02-01T00:00:00Z' });
    expect(searchTracks(buildIndex([a, b]), 'same song').map((x) => x.id)).toEqual(['new', 'old']);
  });

  it('caps the number of results', () => {
    const many = Array.from({ length: 150 }, (_, i) => t({ id: `m${i}`, title: `Rock ${i}` }));
    expect(searchTracks(buildIndex(many), 'rock')).toHaveLength(100);
    expect(searchTracks(buildIndex(many), 'rock', 5)).toHaveLength(5);
  });
});

describe('searchGenres', () => {
  const genres = [
    { name: 'new wave', count: 4 },
    { name: 'darkwave', count: 9 },
    { name: 'synthwave', count: 12 },
    { name: 'soul', count: 20 },
    { name: 'city pop', count: 5 },
    { name: 'pop', count: 30 },
    { name: 'K-Pop', count: 2 },
  ];

  it('uses the same matching, best first', () => {
    expect(searchGenres(genres, 'wave')[0]).toBe('new wave');
    expect(searchGenres(genres, 'wave')).toHaveLength(3);
    expect(searchGenres(genres, 'soup')).toEqual([]);
    expect(searchGenres(genres, 'kpop')).toEqual([]);
    expect(searchGenres(genres, 'k pop')[0]).toBe('K-Pop');
  });

  it('ties go to the genre with more tracks', () => {
    expect(searchGenres(genres, 'pop').slice(0, 3)).toEqual(['pop', 'city pop', 'K-Pop']);
  });

  it('limits to 8 and ignores empty queries', () => {
    const lots = Array.from({ length: 20 }, (_, i) => ({ name: `rock ${i}`, count: i }));
    expect(searchGenres(lots, 'rock')).toHaveLength(8);
    expect(searchGenres(lots, '')).toEqual([]);
  });
});

/** A Global (artist page) song: no poster, no date. */
function g(p: Partial<Track>): Track {
  return t({ by: '', createdAt: '', source: 'ytmusic', id: `ytm:${p.ytId}`, ...p });
}

describe('mergeTracks (artist page "Here")', () => {
  const shared = t({ id: 'post1', ytId: 'SaveTears01', title: 'Save Your Tears', artist: 'The Weeknd', by: 'nightowl' });
  const shared2 = t({ id: 'post2', ytId: 'SaveTears01', title: 'Save Your Tears', artist: 'The Weeknd', by: 'moth' });
  const top = [g({ ytId: 'SaveTears01', title: 'Save Your Tears', artist: 'The Weeknd' }), g({ ytId: 'BlindLight1', title: 'Blinding Lights', artist: 'The Weeknd' })];
  const all = [
    g({ ytId: 'BlindLight1', title: 'Blinding Lights', artist: 'The Weeknd' }),
    g({ ytId: 'BlindLight2', title: 'Blinding  Lights!', artist: 'The Weeknd' }), // same song, another upload
    g({ ytId: 'StarBoy0001', title: 'Starboy', artist: 'The Weeknd, Daft Punk' }),
    g({ ytId: 'StarBoy0002', title: 'Starboy', artist: 'the weeknd' }), // same title and first artist
    g({ ytId: 'Hills000001', title: 'The Hills', artist: 'The Weeknd' }),
  ];

  it('keeps list order (Jukebox first) and drops songs an earlier list already has', () => {
    const merged = mergeTracks([[shared], top, all]);
    expect(merged.map((x) => x.ytId)).toEqual(['SaveTears01', 'BlindLight1', 'StarBoy0001', 'StarBoy0002', 'Hills000001']);
    expect(merged[0]).toBe(shared); // the Jukebox post, not the Global copy
  });

  it('de-duplicates by ytId, or by normalized title plus first credited artist', () => {
    const merged = mergeTracks([top, all]);
    expect(merged.filter((x) => normalize(x.title) === 'blinding lights')).toHaveLength(1);
    expect(merged.filter((x) => x.title === 'Starboy')).toHaveLength(2); // within one list nothing is dropped
    expect(mergeTracks([[all[2]], [all[3]]])).toHaveLength(1);
    // A different song by the same artist stays.
    expect(mergeTracks([[shared], [g({ ytId: 'SaveTearsRx', title: 'Save Your Tears (Remix)', artist: 'The Weeknd' })]])).toHaveLength(2);
  });

  it('keeps two Jukebox posts of one song (one list)', () => {
    expect(mergeTracks([[shared, shared2], top])).toEqual([shared, shared2, top[1]]);
  });

  it('stops at the limit and handles empty lists', () => {
    expect(mergeTracks([[shared], top, all], 2)).toHaveLength(2);
    expect(mergeTracks([])).toEqual([]);
    expect(mergeTracks([[], []])).toEqual([]);
  });

  it('a top song and a song only in the full list are both searchable after merging', () => {
    const idx = buildIndex(mergeTracks([[shared], top, all]));
    expect(searchTracks(idx, 'save').map((x) => x.id)).toEqual(['post1']);
    expect(searchTracks(idx, 'hills').map((x) => x.ytId)).toEqual(['Hills000001']);
  });
});

describe('searchTracks ranking of Jukebox and Global tracks', () => {
  it('puts Jukebox tracks first on equal scores, whatever the list order', () => {
    const jb = t({ id: 'jb', ytId: 'Jukebox0001', title: 'Neon Rain', artist: 'Glass', by: 'x' });
    const gl = g({ ytId: 'Global00001', title: 'Neon Rain', artist: 'Glass' });
    expect(searchTracks(buildIndex([gl, jb]), 'neon rain').map((x) => x.id)).toEqual(['jb', gl.id]);
  });

  it('a better Global match still ranks above a weaker Jukebox one', () => {
    const jb = t({ id: 'jb', ytId: 'Jukebox0001', title: 'Rainy Neon Days', artist: 'Glass', by: 'x' });
    const gl = g({ ytId: 'Global00001', title: 'Neon Rain', artist: 'Glass' });
    expect(searchTracks(buildIndex([jb, gl]), 'neon rain')[0].id).toBe(gl.id);
  });
});

describe('searchTitles', () => {
  const releases = [{ title: 'After Hours' }, { title: 'Dawn FM' }, { title: 'Hours of Static' }, { title: 'Starboy' }];
  it('matches titles word by word, phrase first, ties in the given order', () => {
    expect(searchTitles(releases, (r) => r.title, 'hours').map((r) => r.title)).toEqual(['After Hours', 'Hours of Static']);
    expect(searchTitles(releases, (r) => r.title, 'after hours').map((r) => r.title)).toEqual(['After Hours']);
    expect(searchTitles(releases, (r) => r.title, 'starbo').map((r) => r.title)).toEqual(['Starboy']);
  });
  it('returns nothing for an empty query or no match', () => {
    expect(searchTitles(releases, (r) => r.title, '  ')).toEqual([]);
    expect(searchTitles(releases, (r) => r.title, 'save')).toEqual([]);
  });
});
