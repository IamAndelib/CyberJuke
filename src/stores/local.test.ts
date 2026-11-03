import { describe, expect, it, vi } from 'vitest';
import type { JukeLocalPlugin } from '../data/local';
import { makeTrack } from '../data/model';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: async () => ({ value: null }), set: async () => undefined, remove: async () => undefined },
}));

// Vitest runs in Node: a bare `window` for the fake plugin to sit on.
const removed: string[] = [];
const plugin: JukeLocalPlugin = {
  folders: async () => ({ folders: [{ id: 'f1', name: 'Music', songs: 1, state: 'ok' }, { id: 'f2', name: 'Albums', songs: 1, state: 'ok' }] }),
  addFolder: async () => ({ result: 'cancelled' }),
  removeFolder: async ({ id }) => void removed.push(id),
  tracks: async () => ({
    tracks: [
      { id: 'loc:0000000000000001', title: 'One', artist: 'A', album: '', durationMs: 1, folder: 'f1', cover: false },
      { id: 'loc:0000000000000002', title: 'Two', artist: 'B', album: '', durationMs: 1, folder: 'f2', cover: false },
    ],
  }),
  scan: async () => undefined,
  setEnabled: async () => undefined,
  addListener: async () => ({ remove: async () => undefined }),
};
vi.stubGlobal('window', { __cyberjukeLocalStub: plugin, addEventListener: () => undefined, removeEventListener: () => undefined });

const { byTitle, removeFolder, localTracks, localFolderList, startLocal } = await import('./local');
const { updateSettings } = await import('./library');
const { runToastAction, toasts } = await import('./toast');

const t = (title: string, artist = 'Unknown artist', album = '') => makeTrack({ id: `loc:${title}`, ytId: '', title, artist, ...(album && { album }), source: 'local' });

describe('Local\u2019s songs', () => {
  it('go by title, regardless of case and with numbers in order; songs with no tags at all last', () => {
    const list = [t('memo'), t('Beta', 'Zed', 'Attic'), t('alpha', 'Ana', 'Basement'), t('Gamma', 'Ana'), t('track 10', 'Zed', 'Attic'), t('track 9', 'Zed', 'Attic')];
    expect(byTitle(list).map((x) => x.title)).toEqual(['alpha', 'Beta', 'Gamma', 'track 9', 'track 10', 'memo']);
  });
});

describe('removing a folder', () => {
  it('hides it and its songs at once; Undo brings them back, and only a toast run out gives its access back', async () => {
    updateSettings({ localMusic: true });
    startLocal();
    await vi.waitFor(() => expect(localTracks.value.map((x) => x.title)).toEqual(['One', 'Two']));
    vi.useFakeTimers();
    removeFolder(localFolderList.value[1]!);
    expect(localFolderList.value.map((f) => f.name)).toEqual(['Music']);
    expect(localTracks.value.map((x) => x.title)).toEqual(['One']);
    runToastAction(toasts.value[0]!.id);
    expect(localTracks.value.map((x) => x.title)).toEqual(['One', 'Two']);
    expect(removed).toEqual([]);
    removeFolder(localFolderList.value[1]!);
    await vi.runAllTimersAsync();
    expect(removed).toEqual(['f2']);
    vi.useRealTimers();
  });
});
