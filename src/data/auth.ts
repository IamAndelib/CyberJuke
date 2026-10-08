/**
 * Optional "Sign in with Cyberspace": Cyberspace's own Firebase Auth login (email and
 * password), so members see members-only Jukebox posts like they do on the site.
 *
 * - The password goes only to Google's identitytoolkit endpoint that the site's own
 *   login uses. It is never stored, logged or kept after the request.
 * - What is kept: the refresh token, the user id and the display name, in the
 *   SecureStore (Android Keystore-encrypted; memory only in the browser build).
 * - The ID token (1 hour) lives in memory. It is refreshed REFRESH_EARLY_MS before it
 *   expires (a timer, and on use), and again when Firestore answers 401.
 * - A refresh token the server rejects (expired, revoked, account disabled) signs out.
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import { API_KEY, PROJECT } from './firestore';
import { secureStore, type SecureStorePlugin } from './secureStore';

export const SIGN_IN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`;
export const REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`;
export function userDocUrl(uid: string): string {
  return `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users/${encodeURIComponent(uid)}?mask.fieldPaths=username&key=${API_KEY}`;
}
/** Where new accounts are made (the site's own sign-up). */
export const SIGN_UP_URL = 'https://cyberspace.online/?signup=1';

/** SecureStore key of the saved session. */
export const SESSION_KEY = 'cyberspace.session';
/** Refresh the ID token this long before it expires. */
export const REFRESH_EARLY_MS = 5 * 60 * 1000;
/** Used when the server doesn't say how long a token lasts. */
const DEFAULT_TTL_S = 3600;

// ---- Errors ---------------------------------------------------------------------------

export type AuthErrorCode =
  | 'BAD_CREDENTIALS'
  | 'WRONG_PASSWORD'
  | 'USER_NOT_FOUND'
  | 'TOO_MANY_ATTEMPTS'
  | 'USER_DISABLED'
  | 'INVALID_EMAIL'
  | 'MISSING_FIELDS'
  | 'NETWORK'
  | 'SESSION_EXPIRED'
  | 'UNKNOWN';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string = authErrorText(code),
  ) {
    super(message);
    this.name = 'AuthError';
  }
  get offline(): boolean {
    return this.code === 'NETWORK';
  }
}

/**
 * Firebase's error message ("INVALID_PASSWORD", "TOO_MANY_ATTEMPTS_TRY_LATER : Access
 * to this account…") to a code.
 */
export function authErrorCode(message: string | undefined): AuthErrorCode {
  const m = (message ?? '').split(':')[0].trim().toUpperCase();
  switch (m) {
    case 'INVALID_LOGIN_CREDENTIALS':
      return 'BAD_CREDENTIALS';
    case 'INVALID_PASSWORD':
      return 'WRONG_PASSWORD';
    case 'EMAIL_NOT_FOUND':
    case 'USER_NOT_FOUND':
      return 'USER_NOT_FOUND';
    case 'TOO_MANY_ATTEMPTS_TRY_LATER':
      return 'TOO_MANY_ATTEMPTS';
    case 'USER_DISABLED':
      return 'USER_DISABLED';
    case 'INVALID_EMAIL':
      return 'INVALID_EMAIL';
    case 'MISSING_PASSWORD':
    case 'MISSING_EMAIL':
      return 'MISSING_FIELDS';
    case 'TOKEN_EXPIRED':
    case 'INVALID_REFRESH_TOKEN':
    case 'INVALID_GRANT_TYPE':
    case 'MISSING_REFRESH_TOKEN':
    case 'INVALID_ID_TOKEN':
      return 'SESSION_EXPIRED';
    default:
      return 'UNKNOWN';
  }
}

/** What the sign-in form shows. */
export function authErrorText(code: AuthErrorCode): string {
  switch (code) {
    case 'BAD_CREDENTIALS':
      return 'Wrong email or password.';
    case 'WRONG_PASSWORD':
      return 'Wrong password. Try again.';
    case 'USER_NOT_FOUND':
      return 'No Cyberspace account uses that email.';
    case 'TOO_MANY_ATTEMPTS':
      return 'Too many attempts. Wait a few minutes, then try again.';
    case 'USER_DISABLED':
      return 'This Cyberspace account has been disabled.';
    case 'INVALID_EMAIL':
      return "That doesn't look like an email address.";
    case 'MISSING_FIELDS':
      return 'Enter your email and password.';
    case 'NETWORK':
      return "Couldn't reach Cyberspace. Check your connection and try again.";
    case 'SESSION_EXPIRED':
      return 'Your Cyberspace login has expired. Sign in again.';
    default:
      return "Couldn't sign in right now. Try again later.";
  }
}

// ---- State ----------------------------------------------------------------------------

export type AuthStatus = 'restoring' | 'signedOut' | 'signedIn';

export interface AuthUser {
  uid: string;
  /** "@username", or the email when the username couldn't be read. */
  name: string;
}

export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
}

interface Session {
  uid: string;
  name: string;
  refreshToken: string;
  idToken: string | null;
  /** When idToken expires (ms since epoch); 0 when there is none. */
  expiresAt: number;
}

/** What is saved in the SecureStore. Never the password, never the ID token. */
interface Saved {
  v: 1;
  uid: string;
  name: string;
  refreshToken: string;
}

export type AuthChangeReason = 'signIn' | 'signOut' | 'expired';

export interface AuthDeps {
  store: Pick<SecureStorePlugin, 'get' | 'set' | 'remove'>;
  fetch?: typeof fetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface Auth {
  state: ReadonlySignal<AuthState>;
  signedIn(): boolean;
  /** Read a saved session at startup (no network). Never rejects. */
  restore(): Promise<void>;
  /**
   * Sign in; rejects with an AuthError. The password is not kept. `saved` is false
   * when the login couldn't be stored on the phone: signed in for this session only.
   */
  signIn(email: string, password: string): Promise<AuthUser & { saved: boolean }>;
  signOut(): Promise<void>;
  /** A valid ID token (refreshed first when it's about to expire), or null when signed out. */
  token(): Promise<string | null>;
  /** Refresh now (Firestore said 401). Null when signed out (or the session ended). */
  refreshNow(): Promise<string | null>;
  /** Called after every sign-in and sign-out (including an expired session). */
  onChange(fn: (signedIn: boolean, reason: AuthChangeReason) => void): () => void;
}

interface FirebaseErrorBody {
  error?: { message?: string } | string;
  error_description?: string;
}

function errorMessage(json: unknown): string | undefined {
  const b = json as FirebaseErrorBody | null;
  if (!b) return undefined;
  if (typeof b.error === 'string') return b.error;
  return b.error?.message;
}

export function createAuth(deps: AuthDeps): Auth {
  const fetchFn = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const state = signal<AuthState>({ status: 'restoring', user: null });
  const listeners = new Set<(signedIn: boolean, reason: AuthChangeReason) => void>();
  let session: Session | null = null;
  let refreshing: Promise<string | null> | null = null;
  let timer: unknown = null;
  /** Bumped on every sign-in/out, so a refresh that started before can't revive a session. */
  let epoch = 0;

  const emit = (signedIn: boolean, reason: AuthChangeReason) => {
    for (const fn of [...listeners]) {
      try {
        fn(signedIn, reason);
      } catch {
        /* a listener's failure doesn't stop the others */
      }
    }
  };

  const publish = () => {
    state.value = session ? { status: 'signedIn', user: { uid: session.uid, name: session.name } } : { status: 'signedOut', user: null };
  };

  /** Store the session; false when the store refused (e.g. UNAVAILABLE). */
  const save = (s: Session): Promise<boolean> => {
    const saved: Saved = { v: 1, uid: s.uid, name: s.name, refreshToken: s.refreshToken };
    return deps.store
      .set({ key: SESSION_KEY, value: JSON.stringify(saved) })
      .then(() => true)
      .catch(() => false);
  };

  const stopTimer = () => {
    if (timer != null) clearTimer(timer);
    timer = null;
  };

  const schedule = () => {
    stopTimer();
    if (!session?.idToken) return;
    const wait = Math.max(0, session.expiresAt - REFRESH_EARLY_MS - now());
    timer = setTimer(() => {
      timer = null;
      void refresh().catch(() => {
        /* offline: token() retries on next use */
      });
    }, wait);
  };

  /**
   * Delete the saved session. If the store refuses the delete, overwrite it with an
   * empty value, so no refresh token is left behind either way.
   */
  const forget = async (): Promise<void> => {
    try {
      await deps.store.remove({ key: SESSION_KEY });
    } catch {
      await deps.store.set({ key: SESSION_KEY, value: '' }).catch(() => {});
    }
  };

  const end = async (reason: AuthChangeReason) => {
    const had = !!session;
    epoch++;
    session = null;
    refreshing = null;
    stopTimer();
    await forget();
    publish();
    if (had) emit(false, reason);
  };

  async function post(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; json: unknown }> {
    let res: Response;
    try {
      res = await fetchFn(url, init);
    } catch {
      throw new AuthError('NETWORK');
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* empty or not JSON */
    }
    return { ok: res.ok, status: res.status, json };
  }

  function refresh(): Promise<string | null> {
    if (!session) return Promise.resolve(null);
    if (refreshing) return refreshing;
    const mine = epoch;
    const rt = session.refreshToken;
    refreshing = (async () => {
      const r = await post(REFRESH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt }).toString(),
      });
      if (mine !== epoch || !session) return null;
      const j = r.json as { id_token?: string; refresh_token?: string; expires_in?: string | number; user_id?: string } | null;
      if (!r.ok || !j?.id_token) {
        const code = authErrorCode(errorMessage(r.json));
        // The server rejected the login itself: sign out. Anything else (a 5xx, a 400
        // without one of these codes, a proxy's error page) is retried later.
        if (code === 'SESSION_EXPIRED' || code === 'USER_DISABLED' || code === 'USER_NOT_FOUND') {
          await end('expired');
          return null;
        }
        throw new AuthError(code === 'UNKNOWN' ? 'NETWORK' : code);
      }
      session.idToken = j.id_token;
      session.expiresAt = now() + (Number(j.expires_in) || DEFAULT_TTL_S) * 1000;
      if (j.refresh_token && j.refresh_token !== session.refreshToken) {
        session.refreshToken = j.refresh_token;
        void save(session);
      }
      schedule();
      return session.idToken;
    })().finally(() => {
      if (mine === epoch) refreshing = null;
    });
    return refreshing;
  }

  /** "@username" from users/{uid}, or null when it can't be read. */
  async function username(uid: string, idToken: string): Promise<string | null> {
    try {
      const res = await fetchFn(userDocUrl(uid), { headers: { Authorization: `Bearer ${idToken}` } });
      if (!res.ok) return null;
      const doc = (await res.json()) as { fields?: { username?: { stringValue?: string } } };
      const u = doc?.fields?.username?.stringValue?.trim();
      return u ? '@' + u.replace(/^@/, '') : null;
    } catch {
      return null;
    }
  }

  return {
    state,
    signedIn: () => !!session,

    async restore() {
      try {
        const { value } = await deps.store.get({ key: SESSION_KEY });
        const s = value ? (JSON.parse(value) as Partial<Saved>) : null;
        if (s && s.v === 1 && typeof s.uid === 'string' && typeof s.refreshToken === 'string' && s.refreshToken) {
          session = { uid: s.uid, name: typeof s.name === 'string' && s.name ? s.name : 'your account', refreshToken: s.refreshToken, idToken: null, expiresAt: 0 };
        }
      } catch {
        session = null;
      }
      publish();
    },

    async signIn(email, password) {
      const e = email.trim();
      if (!e || !password) throw new AuthError('MISSING_FIELDS');
      const r = await post(SIGN_IN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: e, password, returnSecureToken: true }),
      });
      const j = r.json as { idToken?: string; refreshToken?: string; expiresIn?: string; localId?: string; email?: string } | null;
      if (!r.ok || !j?.idToken || !j.refreshToken || !j.localId) {
        throw new AuthError(r.ok ? 'UNKNOWN' : authErrorCode(errorMessage(r.json)));
      }
      const name = (await username(j.localId, j.idToken)) ?? j.email ?? e;
      epoch++;
      refreshing = null;
      session = {
        uid: j.localId,
        name,
        refreshToken: j.refreshToken,
        idToken: j.idToken,
        expiresAt: now() + (Number(j.expiresIn) || DEFAULT_TTL_S) * 1000,
      };
      // Can't be stored (Keystore unavailable): signed in until the app closes.
      const saved = await save(session);
      if (!saved) await forget();
      schedule();
      publish();
      emit(true, 'signIn');
      return { uid: session.uid, name: session.name, saved };
    },

    signOut: () => end('signOut'),

    async token() {
      if (!session) return null;
      if (session.idToken && now() < session.expiresAt - REFRESH_EARLY_MS) return session.idToken;
      return refresh();
    },

    async refreshNow() {
      if (!session) return null;
      // A refresh already running (started after the failed request) is good enough.
      if (refreshing) return refreshing;
      session.idToken = null;
      session.expiresAt = 0;
      return refresh();
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** The app's Cyberspace login. */
export const auth = createAuth({ store: secureStore });
