import { describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  REFRESH_EARLY_MS,
  REFRESH_URL,
  SESSION_KEY,
  SIGN_IN_URL,
  authErrorCode,
  authErrorText,
  createAuth,
  userDocUrl,
} from './auth';
import { memorySecureStore } from './secureStore';

const HOUR = 3600_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Opts {
  username?: string | null;
  signIn?: (body: { email: string; password: string }) => Response;
  refresh?: (n: number, form: URLSearchParams) => Response | Promise<Response>;
  storeSetFails?: boolean;
}

function setup(o: Opts = {}) {
  let clock = Date.UTC(2026, 9, 8, 12);
  const timers: { fn: () => void; at: number; id: number }[] = [];
  let nextId = 1;
  const store = memorySecureStore();
  const set = vi.fn(store.set);
  if (o.storeSetFails) set.mockRejectedValue(Object.assign(new Error('UNAVAILABLE'), { code: 'UNAVAILABLE' }));
  let refreshes = 0;
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u === SIGN_IN_URL) {
      const body = JSON.parse(String(init!.body));
      if (o.signIn) return o.signIn(body);
      return json(200, { idToken: 'id-1', refreshToken: 'rt-1', expiresIn: '3600', localId: 'uid-1', email: body.email });
    }
    if (u === REFRESH_URL) {
      refreshes++;
      const form = new URLSearchParams(String(init!.body));
      if (o.refresh) return o.refresh(refreshes, form);
      return json(200, { id_token: `id-r${refreshes}`, refresh_token: 'rt-1', expires_in: '3600', user_id: 'uid-1' });
    }
    if (u.startsWith(userDocUrl('uid-1').split('?')[0])) {
      if (o.username === null) return json(403, { error: { message: 'PERMISSION_DENIED' } });
      return json(200, { fields: { username: { stringValue: o.username ?? 'nightowl' } } });
    }
    throw new Error('unexpected ' + u);
  });
  const auth = createAuth({
    store: { get: store.get, set, remove: store.remove },
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const changes: [boolean, string][] = [];
  auth.onChange((s, r) => changes.push([s, r]));
  return {
    auth,
    fetch,
    store,
    set,
    changes,
    timers,
    refreshCount: () => refreshes,
    tick: async (ms: number) => {
      clock += ms;
      for (const t of timers.filter((x) => x.at <= clock)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe('auth: sign in', () => {
  it('signs in with email and password, reads @username, and keeps only the refresh token', async () => {
    const s = setup();
    await s.auth.restore();
    expect(s.auth.state.value.status).toBe('signedOut');
    const user = await s.auth.signIn(' me@example.com ', 'hunter2-secret');
    expect(user).toEqual({ uid: 'uid-1', name: '@nightowl', saved: true });
    expect(s.auth.state.value).toEqual({ status: 'signedIn', user: { uid: 'uid-1', name: '@nightowl' } });
    expect(s.changes).toEqual([[true, 'signIn']]);
    // The request: email trimmed, returnSecureToken.
    const body = JSON.parse(String(s.fetch.mock.calls[0][1]!.body));
    expect(body).toEqual({ email: 'me@example.com', password: 'hunter2-secret', returnSecureToken: true });
    // The users doc is read with the token.
    expect((s.fetch.mock.calls[1][1]!.headers as Record<string, string>).Authorization).toBe('Bearer id-1');
    // Stored: no password, no ID token.
    const { value } = await s.store.get({ key: SESSION_KEY });
    expect(JSON.parse(value!)).toEqual({ v: 1, uid: 'uid-1', name: '@nightowl', refreshToken: 'rt-1' });
    expect(value).not.toContain('hunter2');
    expect(value).not.toContain('"id-1"');
    expect(value).not.toContain('idToken');
    expect(await s.auth.token()).toBe('id-1');
  });

  it('falls back to the email when the username cannot be read', async () => {
    const s = setup({ username: null });
    expect((await s.auth.signIn('me@example.com', 'pw')).name).toBe('me@example.com');
  });

  it('stays signed in for this session when the login cannot be saved', async () => {
    const s = setup({ storeSetFails: true });
    const user = await s.auth.signIn('me@example.com', 'pw');
    expect(user.saved).toBe(false);
    expect(s.auth.signedIn()).toBe(true);
    expect((await s.store.get({ key: SESSION_KEY })).value).toBeNull();
  });

  it('maps Firebase errors to friendly text', async () => {
    const cases: [string, string][] = [
      ['INVALID_LOGIN_CREDENTIALS', 'Wrong email or password.'],
      ['INVALID_PASSWORD', 'Wrong password. Try again.'],
      ['EMAIL_NOT_FOUND', 'No Cyberspace account uses that email.'],
      ['TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account has been temporarily disabled', 'Too many attempts. Wait a few minutes, then try again.'],
      ['USER_DISABLED', 'This Cyberspace account has been disabled.'],
      ['INVALID_EMAIL', "That doesn't look like an email address."],
      ['SOMETHING_NEW', "Couldn't sign in right now. Try again later."],
    ];
    for (const [message, text] of cases) {
      const s = setup({ signIn: () => json(400, { error: { code: 400, message } }) });
      const err = await s.auth.signIn('a@b.c', 'pw').catch((e) => e);
      expect(err).toBeInstanceOf(AuthError);
      expect(err.message).toBe(text);
      expect(s.auth.signedIn()).toBe(false);
      expect(s.changes).toEqual([]);
    }
  });

  it('reports a network failure as NETWORK (offline)', async () => {
    const s = setup({
      signIn: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const err = await s.auth.signIn('a@b.c', 'pw').catch((e) => e);
    expect(err.code).toBe('NETWORK');
    expect(err.offline).toBe(true);
    expect(err.message).toBe(authErrorText('NETWORK'));
  });

  it('asks for both fields before sending anything', async () => {
    const s = setup();
    await expect(s.auth.signIn('', 'pw')).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    await expect(s.auth.signIn('a@b.c', '')).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it('authErrorCode reads the code before the colon', () => {
    expect(authErrorCode('TOO_MANY_ATTEMPTS_TRY_LATER : x')).toBe('TOO_MANY_ATTEMPTS');
    expect(authErrorCode('TOKEN_EXPIRED')).toBe('SESSION_EXPIRED');
    expect(authErrorCode(undefined)).toBe('UNKNOWN');
  });
});

describe('auth: token refresh', () => {
  it('refreshes REFRESH_EARLY_MS before expiry (timer), and on use when near expiry', async () => {
    const s = setup();
    await s.auth.signIn('a@b.c', 'pw');
    // A timer is set for expiry - 5 min.
    expect(s.timers).toHaveLength(1);
    await s.tick(HOUR - REFRESH_EARLY_MS - 1);
    expect(s.refreshCount()).toBe(0);
    expect(await s.auth.token()).toBe('id-1');
    await s.tick(1);
    expect(s.refreshCount()).toBe(1);
    expect(await s.auth.token()).toBe('id-r1');
    // Refresh form: grant_type=refresh_token.
    const form = new URLSearchParams(String(s.fetch.mock.calls.find((c) => c[0] === REFRESH_URL)![1]!.body));
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('rt-1');
    // The next timer follows the new token.
    expect(s.timers).toHaveLength(1);
    // With timers paused (app in background), token() refreshes on use past the margin.
    s.timers.length = 0;
    await s.tick(HOUR - REFRESH_EARLY_MS + 10);
    expect(await s.auth.token()).toBe('id-r2');
  });

  it('refreshNow (after a 401) gets a new token; concurrent refreshes share one request', async () => {
    const s = setup();
    await s.auth.signIn('a@b.c', 'pw');
    const [a, b] = await Promise.all([s.auth.refreshNow(), s.auth.refreshNow()]);
    expect(a).toBe('id-r1');
    expect(b).toBe('id-r1');
    expect(s.refreshCount()).toBe(1);
  });

  it('saves a rotated refresh token', async () => {
    const s = setup({ refresh: () => json(200, { id_token: 'id-x', refresh_token: 'rt-2', expires_in: '3600' }) });
    await s.auth.signIn('a@b.c', 'pw');
    await s.auth.refreshNow();
    await Promise.resolve();
    expect(JSON.parse((await s.store.get({ key: SESSION_KEY })).value!).refreshToken).toBe('rt-2');
  });

  it('a rejected refresh token signs out (expired) and clears the store', async () => {
    const s = setup({ refresh: () => json(400, { error: { message: 'TOKEN_EXPIRED' } }) });
    await s.auth.signIn('a@b.c', 'pw');
    expect(await s.auth.refreshNow()).toBeNull();
    expect(s.auth.signedIn()).toBe(false);
    expect(s.changes).toEqual([
      [true, 'signIn'],
      [false, 'expired'],
    ]);
    expect((await s.store.get({ key: SESSION_KEY })).value).toBeNull();
  });

  it('a refresh that fails offline keeps the session', async () => {
    const s = setup({
      refresh: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await s.auth.signIn('a@b.c', 'pw');
    await expect(s.auth.refreshNow()).rejects.toMatchObject({ code: 'NETWORK' });
    expect(s.auth.signedIn()).toBe(true);
  });
});

describe('auth: restore and sign out', () => {
  it('restores a saved session without a request, then refreshes on first use', async () => {
    const s = setup();
    await s.store.set({ key: SESSION_KEY, value: JSON.stringify({ v: 1, uid: 'uid-1', name: '@nightowl', refreshToken: 'rt-1' }) });
    await s.auth.restore();
    expect(s.auth.state.value).toEqual({ status: 'signedIn', user: { uid: 'uid-1', name: '@nightowl' } });
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.changes).toEqual([]);
    expect(await s.auth.token()).toBe('id-r1');
  });

  it('ignores a missing or unreadable saved session', async () => {
    const s = setup();
    await s.store.set({ key: SESSION_KEY, value: 'garbage' });
    await s.auth.restore();
    expect(s.auth.state.value.status).toBe('signedOut');
  });

  it('sign out forgets the token and tells listeners', async () => {
    const s = setup();
    await s.auth.signIn('a@b.c', 'pw');
    await s.auth.signOut();
    expect(s.auth.signedIn()).toBe(false);
    expect(await s.auth.token()).toBeNull();
    expect((await s.store.get({ key: SESSION_KEY })).value).toBeNull();
    expect(s.changes.at(-1)).toEqual([false, 'signOut']);
    expect(s.timers).toHaveLength(0);
  });

  it('a refresh still running when signing out cannot revive the session', async () => {
    let release!: (r: Response) => void;
    const s = setup({ refresh: () => new Promise<Response>((r) => (release = r)) });
    await s.auth.signIn('a@b.c', 'pw');
    const p = s.auth.refreshNow();
    await new Promise((r) => setTimeout(r, 0));
    await s.auth.signOut();
    release(json(200, { id_token: 'late', expires_in: '3600' }));
    expect(await p).toBeNull();
    expect(s.auth.signedIn()).toBe(false);
  });
});
