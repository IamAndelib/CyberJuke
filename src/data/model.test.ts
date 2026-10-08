import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/runquery-sample.json';
import { parseYouTubeId, tracksFromDocument, tracksFromRows, type FsDocument, type FsRunQueryRow } from './model';

const rows = fixture as unknown as FsRunQueryRow[];

describe('parseYouTubeId', () => {
  const cases: [string, string | null][] = [
    ['https://www.youtube.com/watch?v=WeVLw9GJbWM', 'WeVLw9GJbWM'],
    ['https://youtu.be/VgUy-Mazsbw', 'VgUy-Mazsbw'],
    ['https://youtu.be/VgUy-Mazsbw?si=abc&t=10', 'VgUy-Mazsbw'],
    ['https://music.youtube.com/watch?v=gPbGK_62bLU', 'gPbGK_62bLU'],
    ['http://music.youtube.com/watch?v=5jxdjeYumRY', '5jxdjeYumRY'],
    [
      'https://m.youtube.com/watch?v=DVkrh9fihFk&list=RDDVkrh9fihFk&start_radio=1&pp=ygUbY2xvYWsgb2YgZmVhdGhlcnMgdGhlIHN3b3JkoAcB&ra=m',
      'DVkrh9fihFk',
    ],
    ['https://m.youtube.com/watch?v=MJkr0DWbhTk&ra=m', 'MJkr0DWbhTk'],
    ['https://www.youtube.com/live/Q89Dzox4jAE?si=fTtVGemhUy5tccwJ', 'Q89Dzox4jAE'],
    ['https://www.youtube.com/shorts/abcdefghijk', 'abcdefghijk'],
    ['https://www.youtube.com/embed/abcdefghijk?autoplay=1', 'abcdefghijk'],
    ['https://www.youtube-nocookie.com/embed/abcdefghijk', 'abcdefghijk'],
    ['https://www.youtube.com/watch?feature=share&v=WeVLw9GJbWM#t=30', 'WeVLw9GJbWM'],
    ['https://youtu.be/WeVLw9GJbWM#frag', 'WeVLw9GJbWM'],
    ['youtube.com/watch?v=WeVLw9GJbWM', 'WeVLw9GJbWM'],
    ['  https://youtu.be/WeVLw9GJbWM  ', 'WeVLw9GJbWM'],
    ['https://www.youtube.com/watch?v=short', null],
    ['https://www.youtube.com/watch?v=WeVLw9GJbWMXX', null],
    ['https://youtu.be/WeVLw9GJbW!', null],
    ['https://www.youtube.com/channel/UCabcdefghijklmnop', null],
    ['https://www.youtube.com/', null],
    ['https://soundcloud.com/foo/bar', null],
    ['https://notyoutube.com/watch?v=WeVLw9GJbWM', null],
    ['https://evil.com/youtu.be/WeVLw9GJbWM', null],
    ['javascript:alert(1)', null],
    ['not a url', null],
    ['', null],
    [null as unknown as string, null],
  ];
  it.each(cases)('%s -> %s', (src, want) => {
    expect(parseYouTubeId(src)).toBe(want);
  });
});

describe('tracksFromRows with live fixtures', () => {
  const tracks = tracksFromRows(rows);

  it('parses every fixture document into exactly one track', () => {
    expect(rows.length).toBe(12);
    expect(tracks.length).toBe(12);
  });

  it('extracts the id from every src form in the fixtures', () => {
    expect(tracks.map((t) => t.ytId)).toEqual([
      'VgUy-Mazsbw',
      'gPbGK_62bLU',
      'jVExs4d4-7o',
      'WeVLw9GJbWM',
      'qfXMbZTMP4k',
      '2Ng9Pf_p7Fw',
      '5jxdjeYumRY',
      'DVkrh9fihFk',
      'MJkr0DWbhTk',
      'Q89Dzox4jAE',
      'JeyLI3xgQok',
      'EXRu5ihe8jU',
    ]);
  });

  it('maps all fields of a track', () => {
    expect(tracks[0]).toEqual({
      id: 'zxQ91atgkGA6lzKlLobH',
      ytId: 'VgUy-Mazsbw',
      title: 'Kaigomai',
      artist: 'APON',
      genre: 'greek',
      by: 'monimos',
      postTitle: 'Am I being stalked by a Greek Celebrity???',
      postUrl: 'https://beta.cyberspace.online/monimos/am-i-being-stalked-by-a-greek-celebrity',
      createdAt: '2026-10-05T00:26:30.893Z',
      nsfw: false,
      artworkUrl: 'https://i.ytimg.com/vi/VgUy-Mazsbw/hqdefault.jpg',
      saves: 1,
      replies: 16,
    });
  });

  it('leaves saves/replies undefined when the counts are missing', () => {
    const [t] = tracksFromDocument({
      name: 'projects/p/databases/(default)/documents/posts/x',
      fields: {
        attachments: {
          arrayValue: { values: [{ mapValue: { fields: { type: { stringValue: 'audio' }, src: { stringValue: 'https://youtu.be/VgUy-Mazsbw' } } } }] },
        },
      },
    });
    expect(t.saves).toBeUndefined();
    expect(t.replies).toBeUndefined();
    expect('saves' in t).toBe(false);
  });

  it('flags the NSFW post', () => {
    const nsfw = tracks.filter((t) => t.nsfw);
    expect(nsfw.map((t) => t.id)).toEqual(['nesQOZiWyMuSEWpTRZjL']);
  });

  it('keeps genres as lowercase free text', () => {
    expect(new Set(tracks.map((t) => t.genre))).toEqual(
      new Set([
        'greek',
        'indie pop',
        'death metal',
        'heavy metal',
        'folk',
        'electronic',
        'doom metal',
        'folk-rock',
        'chillout',
        'electro house',
        'electronic rock',
      ]),
    );
  });

  it('handles empty titles', () => {
    expect(tracks[1].postTitle).toBe('');
  });
});

describe('tracksFromDocument edge cases', () => {
  const base = rows[0].document!;
  const withAttachments = (values: unknown[]): FsDocument => ({
    ...base,
    fields: { ...base.fields, attachments: { arrayValue: { values: values as never } } },
  });
  const att = (src: string, extra: Record<string, string> = {}) => ({
    mapValue: {
      fields: Object.fromEntries(
        Object.entries({ type: 'audio', origin: 'youtube', src, artist: 'A', title: 'T', genre: 'rock', ...extra }).map(
          ([k, v]) => [k, { stringValue: v }],
        ),
      ),
    },
  });

  it('suffixes ids with the attachment index when a post has several audio attachments', () => {
    const doc = withAttachments([
      { mapValue: { fields: { type: { stringValue: 'image' }, src: { stringValue: 'x.png' } } } },
      att('https://youtu.be/aaaaaaaaaaa'),
      att('https://youtu.be/bbbbbbbbbbb'),
    ]);
    expect(tracksFromDocument(doc).map((t) => t.id)).toEqual(['zxQ91atgkGA6lzKlLobH-1', 'zxQ91atgkGA6lzKlLobH-2']);
  });

  it('skips unparseable and non-youtube attachments', () => {
    const doc = withAttachments([
      att('https://soundcloud.com/x/y', { origin: 'soundcloud' }),
      att('https://youtube.com/watch?v=bad'),
      att('https://youtu.be/ccccccccccc'),
    ]);
    const t = tracksFromDocument(doc);
    expect(t.map((x) => x.ytId)).toEqual(['ccccccccccc']);
    expect(t[0].id).toBe('zxQ91atgkGA6lzKlLobH-2');
  });

  it('returns nothing for a post without attachments', () => {
    expect(tracksFromDocument({ name: 'a/b/posts/x', fields: {} })).toEqual([]);
  });

  it('falls back to placeholder title/artist', () => {
    const [t] = tracksFromDocument(withAttachments([att('https://youtu.be/ccccccccccc', { title: ' ', artist: '' })]));
    expect(t.title).toBe('Untitled');
    expect(t.artist).toBe('Unknown artist');
  });
});
