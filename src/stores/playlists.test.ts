import { signal } from '@preact/signals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonFile } from '../core/storage';
import type { Track } from '../data/model';
import type { CreateResult } from './playlists';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: async () => ({ value: null }), set: async () => undefined, remove: async () => undefined },
}));
// Who is signed in, set by each test.
const authState = signal<{ status: 'signedIn' | 'signedOut'; user: { uid: string; name: string } | null }>({ status: 'signedOut', user: null });
vi.mock('../data/auth', () => ({ auth: { state: authState, signedIn: () => authState.value.status === 'signedIn', onChange: () => () => undefined } }));

const pl = await import('./playlists');
const { localHere, settings } = await import('./library');
const { addToPlaylistWithUndo, createWithSongWithUndo, removeFromPlaylistWithUndo } = await import('./undo');
const { runToastAction, toasts } = await import('./toast');

/** An in-memory playlists file. */
function memoryFile(initial: unknown = null): JsonFile<unknown> & { value: unknown } {
  const f = {
    value: initial,
    path: 'mem',
    unreadable: false,
    load: async () => f.value,
    save: async (v: unknown) => void (f.value = JSON.parse(JSON.stringify(v))),
    remove: async () => void (f.value = null),
  };
  return f;
}

const tr = (id: string, o: Partial<Track> = {}): Track => ({ id, ytId: id.padEnd(11, 'x').slice(0, 11), title: id, artist: 'A', genre: '', by: '', postTitle: '', postUrl: '', createdAt: '', nsfw: false, artworkUrl: '', ...o });
const idOf = (r: CreateResult) => (r.result === 'created' ? r.id : '');
const shownTitles = (id: string) => pl.playlistShown(id)?.tracks.map((t) => t.title);
const lastToast = () => toasts.value.at(-1)!;

let file = memoryFile();
beforeEach(async () => {
  file = memoryFile();
  pl.setPlaylistsFile(file);
  await pl.loadPlaylists();
  authState.value = { status: 'signedOut', user: null };
});

describe('making and naming playlists', () => {
  it('names are trimmed and capped; an empty one is refused; the newest shows first', () => {
    expect(pl.createPlaylist('   ').result).toBe('unnamed');
    const a = idOf(pl.createPlaylist('  Night   drive  ', [], 1));
    const b = idOf(pl.createPlaylist('x'.repeat(80), [], 2));
    expect(pl.playlistsShown.value.map((p) => p.name)).toEqual(['x'.repeat(60), 'Night drive']);
    expect(pl.renamePlaylist(a, ' ')).toBe(false);
    expect(pl.renamePlaylist(a, 'Road trip')).toBe(true);
    expect(pl.playlistShown(a)?.name).toBe('Road trip');
    pl.deletePlaylist(b);
    expect(pl.playlistsShown.value.map((p) => p.id)).toEqual([a]);
  });

  it('Undo of a delete brings the playlist back where it was, with its songs', () => {
    const a = (pl.createPlaylist('A') as { id: string }).id;
    const b = (pl.createPlaylist('B', [tr('s1'), tr('s2')]) as { id: string }).id;
    const c = (pl.createPlaylist('C') as { id: string }).id;
    const gone = pl.deletePlaylist(b)!;
    expect(pl.playlistsShown.value.map((p) => p.id)).toEqual([a, c]);
    pl.restorePlaylist(gone);
    expect(pl.playlistsShown.value.map((p) => p.id)).toEqual([a, b, c]);
    expect(pl.playlistShown(b)?.tracks.map((t) => t.id)).toEqual(['s1', 's2']);
    // A second Undo changes nothing.
    pl.restorePlaylist(gone);
    expect(pl.playlistsShown.value).toHaveLength(3);
  });

  it('stops at the most playlists there can be', () => {
    for (let i = 0; i < pl.PLAYLISTS_MAX; i++) pl.createPlaylist(`P${i}`);
    expect(pl.createPlaylist('one more').result).toBe('full');
  });
});

describe('songs in a playlist', () => {
  it('each song is in it once, up to the limit; a new one goes at the end', () => {
    const id = idOf(pl.createPlaylist('P', [tr('a'), tr('a'), tr('b')]));
    expect(shownTitles(id)).toEqual(['a', 'b']);
    expect(pl.addToPlaylist(id, tr('a'))).toBe('already');
    expect(pl.addToPlaylist(id, tr('c'))).toBe('added');
    expect(shownTitles(id)).toEqual(['a', 'b', 'c']);
    const big = idOf(pl.createPlaylist('Big', Array.from({ length: pl.PLAYLIST_MAX_SONGS + 5 }, (_, i) => tr(`s${i}`))));
    expect(pl.playlistShown(big)?.tracks).toHaveLength(pl.PLAYLIST_MAX_SONGS);
    expect(pl.addToPlaylist(big, tr('more'))).toBe('full');
  });

  it('moves one place up or down; the ends stay put', () => {
    const id = idOf(pl.createPlaylist('P', [tr('a'), tr('b'), tr('c')]));
    pl.moveInPlaylist(id, 'c', -1);
    expect(shownTitles(id)).toEqual(['a', 'c', 'b']);
    pl.moveInPlaylist(id, 'a', -1);
    pl.moveInPlaylist(id, 'b', 1);
    expect(shownTitles(id)).toEqual(['a', 'c', 'b']);
    pl.moveInPlaylist(id, 'a', 1);
    expect(shownTitles(id)).toEqual(['c', 'a', 'b']);
  });

  it('a removed song comes back where it was with Undo', () => {
    const id = idOf(pl.createPlaylist('Night drive', [tr('a'), tr('b'), tr('c')]));
    removeFromPlaylistWithUndo(id, 'b');
    expect(shownTitles(id)).toEqual(['a', 'c']);
    expect(lastToast().text).toBe('Removed from Night drive');
    runToastAction(lastToast().id);
    expect(shownTitles(id)).toEqual(['a', 'b', 'c']);
  });

  it('adding says so and Undo takes the song out; a song already in it says that instead', () => {
    const id = idOf(pl.createPlaylist('Night drive', [tr('a')]));
    addToPlaylistWithUndo(id, tr('b'));
    expect(lastToast().text).toBe('Added to Night drive');
    runToastAction(lastToast().id);
    expect(shownTitles(id)).toEqual(['a']);
    addToPlaylistWithUndo(id, tr('a'));
    expect(lastToast().text).toBe('Already in Night drive');
  });

  it('a playlist made from a song keeps itself when Undo takes the song out', () => {
    const id = createWithSongWithUndo('Road trip', tr('a'))!;
    expect(shownTitles(id)).toEqual(['a']);
    expect(lastToast().text).toBe('Added to Road trip');
    runToastAction(lastToast().id);
    expect(pl.playlistShown(id)?.tracks).toEqual([]);
    expect(pl.playlistsShown.value.map((p) => p.name)).toContain('Road trip');
  });
});

describe('what shows', () => {
  it('a members-only song shows only while the account it was added under is signed in', () => {
    authState.value = { status: 'signedIn', user: { uid: 'A', name: 'a' } };
    const id = idOf(pl.createPlaylist('P', [tr('pub'), tr('mem', { membersOnly: true })]));
    expect(shownTitles(id)).toEqual(['pub', 'mem']);
    authState.value = { status: 'signedOut', user: null };
    expect(shownTitles(id)).toEqual(['pub']);
    authState.value = { status: 'signedIn', user: { uid: 'B', name: 'b' } };
    expect(shownTitles(id)).toEqual(['pub']);
    authState.value = { status: 'signedIn', user: { uid: 'A', name: 'a' } };
    expect(shownTitles(id)).toEqual(['pub', 'mem']);
  });

  it('NSFW songs follow the setting, and local songs not on the phone now hide (and are kept)', () => {
    const local = tr('loc:0000000000000001', { ytId: '', source: 'local' });
    const id = idOf(pl.createPlaylist('P', [tr('a'), tr('n', { nsfw: true }), local]));
    expect(shownTitles(id)).toEqual(['a']);
    settings.value = { ...settings.peek(), showNsfw: true };
    localHere.value = new Set([local.id]);
    expect(shownTitles(id)).toEqual(['a', 'n', local.title]);
    settings.value = { ...settings.peek(), showNsfw: false };
    localHere.value = new Set();
  });
});

describe('the playlists file', () => {
  it('keeps every playlist across a restart; a broken or unknown file reads as none', async () => {
    authState.value = { status: 'signedIn', user: { uid: 'A', name: 'a' } };
    const id = idOf(pl.createPlaylist('Night drive', [tr('a'), tr('m', { membersOnly: true })], 5));
    const saved = file.value;
    pl.setPlaylistsFile(memoryFile(saved));
    await pl.loadPlaylists();
    expect(pl.playlistShown(id)).toMatchObject({ name: 'Night drive', created: 5 });
    expect(shownTitles(id)).toEqual(['a', 'm']);
    for (const junk of [null, 'x', { version: 2, playlists: [] }, { version: 1, playlists: 'no' }]) {
      pl.setPlaylistsFile(memoryFile(junk));
      await pl.loadPlaylists();
      expect(pl.playlists.value).toEqual([]);
    }
  });

  it('a playlist made before the file was read is kept with those in it', async () => {
    const saved = { version: 1, playlists: [{ id: 'old', name: 'Old', created: 1, updated: 1, tracks: [tr('a')] }] };
    const f = memoryFile(saved);
    pl.setPlaylistsFile(f);
    const id = idOf(pl.createPlaylist('Early'));
    await pl.loadPlaylists();
    expect(pl.playlists.value.map((p) => p.id).sort()).toEqual([id, 'old'].sort());
    expect((f.value as { playlists: unknown[] }).playlists).toHaveLength(2);
  });
});
