import { describe, expect, it, vi } from 'vitest';
import type { JukeLocalPlugin } from '../data/local';

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
      { id: 'loc:0000000000000001', title: 'One', artist: 'A', album: '', durationMs: 1, modified: 1000, folder: 'f1', cover: false },
      { id: 'loc:0000000000000002', title: 'Two', artist: 'B', album: '', durationMs: 1, modified: 2000, folder: 'f2', cover: false },
    ],
  }),
  scan: async () => undefined,
  setEnabled: async () => undefined,
  addListener: async () => ({ remove: async () => undefined }),
};
vi.stubGlobal('window', { __cyberjukeLocalStub: plugin, addEventListener: () => undefined, removeEventListener: () => undefined });

const { newestLocal, removeFolder, localTracks, localFolderList, startLocal } = await import('./local');
const { updateSettings } = await import('./library');
const { runToastAction, toasts } = await import('./toast');

describe('Local\u2019s songs', () => {
  it('newest first goes by the file\u2019s date, the latest at the top', async () => {
    updateSettings({ localMusic: true });
    startLocal();
    await vi.waitFor(() => expect(newestLocal.value.map((x) => x.title)).toEqual(['Two', 'One']));
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
