import { afterEach, describe, expect, it, vi } from 'vitest';
import { addLocalFolder, localArtUrl, localAvailable, localFolders, localSongs, onLocalChanged, type JukeLocalPlugin } from './local';

function stub(over: Partial<JukeLocalPlugin> = {}): JukeLocalPlugin {
  return {
    folders: async () => ({ folders: [{ id: 'f', name: 'Music', songs: 1, state: 'ok' }] }),
    addFolder: async () => ({ result: 'cancelled' }),
    removeFolder: async () => undefined,
    tracks: async () => ({ tracks: [{ id: 'loc:0123456789abcdef', title: 'A', artist: 'B', album: '', durationMs: 1, folder: 'f', cover: false }] }),
    scan: async () => undefined,
    setEnabled: async () => undefined,
    addListener: async () => ({ remove: async () => undefined }),
    ...over,
  };
}

// Vitest runs in Node: a bare `window` for the fake to sit on.
const win = { __cyberjukeLocalStub: undefined as JukeLocalPlugin | undefined };
vi.stubGlobal('window', win);
afterEach(() => {
  win.__cyberjukeLocalStub = undefined;
});

describe('data/local', () => {
  it('has no local music in the browser without a fake', async () => {
    expect(localAvailable()).toBe(false);
    expect(await localFolders()).toEqual([]);
    expect(await localSongs()).toEqual([]);
    expect(await addLocalFolder()).toEqual({ result: 'cancelled' });
  });

  it('parses what the plugin answers', async () => {
    win.__cyberjukeLocalStub = stub({ addFolder: async () => ({ result: 'inside', name: 'Music' }) });
    expect(localAvailable()).toBe(true);
    expect((await localFolders())[0]?.name).toBe('Music');
    expect((await localSongs())[0]?.id).toBe('loc:0123456789abcdef');
    expect(await addLocalFolder()).toEqual({ result: 'inside', name: 'Music' });
  });

  it('an added folder comes back parsed, and a malformed answer reads as cancelled', async () => {
    win.__cyberjukeLocalStub = stub({ addFolder: async () => ({ result: 'added', folder: { id: 'f2', name: 'Albums', songs: 0, state: 'scanning' } }) });
    expect(await addLocalFolder()).toEqual({ result: 'added', folder: { id: 'f2', name: 'Albums', songs: 0, state: 'scanning' } });
    win.__cyberjukeLocalStub = stub({ addFolder: async () => ({ result: 'added' }) });
    expect(await addLocalFolder()).toEqual({ result: 'cancelled' });
  });

  it('passes scan progress on, cleaned', async () => {
    let fire: (e: unknown) => void = () => undefined;
    win.__cyberjukeLocalStub = stub({ addListener: async (_e, cb) => ((fire = cb), { remove: async () => undefined }) });
    const seen = vi.fn();
    await onLocalChanged(seen);
    fire({ scanning: 'f', found: 12, done: false });
    fire({ found: 'x', done: true });
    expect(seen.mock.calls.map((c) => c[0])).toEqual([
      { scanning: 'f', found: 12, done: false },
      { scanning: null, found: 0, done: true },
    ]);
  });

  it('serves a cover on the page own origin by the id hex', () => {
    expect(localArtUrl('loc:0123456789abcdef')).toBe('/_local/art/0123456789abcdef.jpg');
  });
});
