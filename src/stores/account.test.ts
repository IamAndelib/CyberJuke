import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The login: signed in as u1 at startup (a saved session), changes emitted by hand. */
const fakeAuth = vi.hoisted(() => {
  const listeners = new Set<(signedIn: boolean, reason: string) => void>();
  const a = {
    uid: 'u1' as string | null,
    state: {
      get value() {
        return { status: a.uid ? 'signedIn' : 'signedOut', user: a.uid ? { uid: a.uid, name: '@u1' } : null };
      },
    },
    signedIn: () => !!a.uid,
    onChange: (fn: (signedIn: boolean, reason: string) => void) => (listeners.add(fn), () => listeners.delete(fn)),
    reset() {
      a.uid = 'u1';
      listeners.clear();
    },
    emit(signedIn: boolean, reason: string) {
      a.uid = signedIn ? 'u1' : null;
      for (const fn of listeners) fn(signedIn, reason);
    },
  };
  return a;
});
/** What reached Liked and history, in order. */
const calls = vi.hoisted(() => [] as string[]);

vi.mock('../data/auth', () => ({ auth: fakeAuth }));
vi.mock('../data', () => ({ source: { invalidateAll: vi.fn() } }));
vi.mock('../data/lyrics', () => ({ lyrics: { dropMembersOnly: vi.fn(async () => {}) } }));
const fakeCatalog = vi.hoisted(() => ({ reset: vi.fn(async () => {}), refresh: vi.fn(async () => {}), settled: vi.fn(async () => {}), all: { value: [] as { genre: string }[] }, error: { value: null } }));
vi.mock('./catalog', () => ({ catalog: fakeCatalog }));
vi.mock('./feed', () => ({ feeds: { deletePrefix: vi.fn() }, JUKEBOX_FEED_PREFIXES: [] }));
vi.mock('./newTracks', () => ({ freshness: { reset: vi.fn() } }));
vi.mock('./toast', () => ({ toast: vi.fn(), dropToastActions: vi.fn() }));
vi.mock('./library', () => ({
  dropMembersOnly: (uid: string | null = null) => void calls.push(`drop:${uid}`),
  returnMembersOnly: async (uid: string) => void calls.push(`return:${uid}`),
}));

beforeEach(() => {
  vi.resetModules();
  calls.length = 0;
  fakeAuth.reset();
});

describe('startAccount', () => {
  it('a login that expires before Liked and history are read: its members-only tracks are kept for it, in order', async () => {
    const { startAccount } = await import('./account');
    const { toast } = await import('./toast');
    let read!: () => void;
    startAccount(new Promise<void>((r) => (read = r)));
    // restore()'s background refresh answers first: the login has expired.
    fakeAuth.emit(false, 'expired');
    // Heard at once (the toast), but Liked and history aren't touched before they're read.
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('login expired'), 4000);
    await Promise.resolve();
    expect(calls).toEqual([]);
    read();
    await vi.waitFor(() => expect(calls).toEqual(['return:u1', 'drop:u1']));
  });

  it('the expired-login message has a Settings button that opens Settings (the app hands in how)', async () => {
    const { startAccount } = await import('./account');
    const { toast } = await import('./toast');
    const openSettings = vi.fn();
    startAccount(Promise.resolve(), openSettings);
    fakeAuth.emit(false, 'expired');
    const action = vi.mocked(toast).mock.calls.at(-1)?.[2];
    expect(action?.label).toBe('Settings');
    action?.run();
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it('signed out at startup: members-only tracks are dropped once the lists are read', async () => {
    fakeAuth.uid = null;
    const { startAccount } = await import('./account');
    let read!: () => void;
    startAccount(new Promise<void>((r) => (read = r)));
    await Promise.resolve();
    expect(calls).toEqual([]);
    read();
    await vi.waitFor(() => expect(calls).toEqual(['drop:null']));
  });

  it('signed out at startup: the lyrics cache drops members-only lyrics once the page is idle, not during startup', async () => {
    vi.useFakeTimers();
    try {
      fakeAuth.uid = null;
      const { startAccount } = await import('./account');
      const { lyrics } = await import('../data/lyrics');
      startAccount();
      expect(lyrics.dropMembersOnly).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);
      expect(lyrics.dropMembersOnly).toHaveBeenCalledTimes(1);
      // A sign-out drops them at once.
      fakeAuth.emit(true, 'signIn');
      fakeAuth.emit(false, 'signOut');
      expect(lyrics.dropMembersOnly).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a list that could not be read still follows sign-outs', async () => {
    const { startAccount } = await import('./account');
    startAccount(Promise.reject(new Error('unreadable')));
    fakeAuth.emit(false, 'signOut');
    await vi.waitFor(() => expect(calls).toEqual(['return:u1', 'drop:u1']));
  });
});

describe('genre tracks signed in (source.genreTracks)', () => {
  it('reads the catalog shown, after a sign-in or out has its own, without starting a refresh', async () => {
    await import('./account');
    const { source } = (await import('../data')) as unknown as { source: { genreTracks: (g: string) => Promise<{ genre: string }[]> } };
    fakeCatalog.refresh.mockClear();
    fakeCatalog.settled.mockClear();
    fakeCatalog.all.value = [{ genre: 'rock' }, { genre: 'pop' }];
    expect(await source.genreTracks('rock')).toEqual([{ genre: 'rock' }]);
    expect(fakeCatalog.settled).toHaveBeenCalled();
    // A stale catalog refreshes in its own time: a genre doesn't wait for (or start) a download.
    expect(fakeCatalog.refresh).not.toHaveBeenCalled();
    // Nothing to read yet: then it loads it.
    fakeCatalog.all.value = [];
    await source.genreTracks('rock');
    expect(fakeCatalog.refresh).toHaveBeenCalledTimes(1);
  });
});
