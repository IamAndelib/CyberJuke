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
vi.mock('./catalog', () => ({ catalog: { reset: vi.fn(async () => {}), refresh: vi.fn(async () => {}), all: { value: [] }, error: { value: null } } }));
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

  it('a list that could not be read still follows sign-outs', async () => {
    const { startAccount } = await import('./account');
    startAccount(Promise.reject(new Error('unreadable')));
    fakeAuth.emit(false, 'signOut');
    await vi.waitFor(() => expect(calls).toEqual(['return:u1', 'drop:u1']));
  });
});
