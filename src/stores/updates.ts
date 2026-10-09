/**
 * Updates: is a newer stable release out? Asks GitHub for the latest release (the one the
 * README's download link points to) and compares it with this install.
 * - Automatic (Settings → Updates, on by default): at most once a day, when the app opens or
 *   comes back to the foreground (after a failed check, not again for an hour). "Check now"
 *   any time.
 * - Installed through F-Droid (or another F-Droid client): F-Droid brings the updates, so
 *   the app never asks GitHub. Until the app knows how it was installed, it doesn't ask
 *   either (nor if it can't tell).
 * - A newer release shows in Settings (with a link to download it) and as a dot on the
 *   Settings tab.
 */
import { computed, signal } from '@preact/signals';
import { Capacitor } from '@capacitor/core';
import { kv } from '../core/storage';
import { logError } from '../core/log';
import { settings } from './library';

export const RELEASES_URL = 'https://github.com/IamAndelib/CyberJuke/releases';
const LATEST_API = 'https://api.github.com/repos/IamAndelib/CyberJuke/releases/latest';
/** Automatic checks: at most this often. */
export const AUTO_CHECK_MS = 24 * 60 * 60 * 1000;
/** After a failed check (offline, GitHub's rate limit), no automatic one for this long. */
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const K_UPDATES = 'updates';

/** Installers that are F-Droid clients: they update the app themselves. */
const FDROID_INSTALLERS = new Set([
  'org.fdroid.fdroid',
  'org.fdroid.basic',
  'org.fdroid.fdroid.privileged',
  'com.looker.droidify',
  'com.machiav3lli.fdroid',
  'eu.bubu1.fdroidclassic',
  'nya.kitsunyan.foxydroid',
  'com.aurora.adroid',
  'org.fdroid.fdroid.debug',
]);

export interface Release {
  version: string;
  url: string;
}

interface Saved {
  checkedAt: number;
  latest: Release | null;
}

/** "1.2.3" (a leading v, and a suffix like "-preview", are ignored); null if not one. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `a` is a later version than `b` (false when either isn't a version). */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export function isFdroidInstaller(installer: string | null | undefined): boolean {
  return installer != null && FDROID_INSTALLERS.has(installer);
}

/**
 * An automatic check is due: never checked, or the last one is a day old; but not within
 * an hour of a failed attempt (`failedAt`).
 */
export function autoCheckDue(checkedAt: number, now = Date.now(), failedAt = 0): boolean {
  if (failedAt && now >= failedAt && now - failedAt < RETRY_AFTER_FAILURE_MS) return false;
  return !checkedAt || now - checkedAt >= AUTO_CHECK_MS || now < checkedAt;
}

/** GitHub's latest-release answer as a Release (a stable x.y.z tag), or null. */
export function releaseOf(json: unknown): Release | null {
  const o = (json ?? {}) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  if (typeof o.tag_name !== 'string' || o.draft === true || o.prerelease === true) return null;
  const p = parseVersion(o.tag_name);
  if (!p || /[-+]/.test(o.tag_name)) return null;
  const url = typeof o.html_url === 'string' && o.html_url.startsWith(`${RELEASES_URL}/`) ? o.html_url : `${RELEASES_URL}/latest`;
  return { version: p.join('.'), url };
}

/**
 * This install: its version, and whether F-Droid updates it (null in the app until Android
 * has said how it was installed, or if it couldn't: no request to GitHub then).
 */
export const app = signal<{ version: string; fdroid: boolean | null }>({ version: __APP_VERSION__, fdroid: Capacitor.isNativePlatform() ? null : false });
/** The last check: when, and the latest release then. */
export const lastCheck = signal<Saved>({ checkedAt: 0, latest: null });
export const checking = signal(false);
/** The last check failed (offline, GitHub unreachable): shown until the next one. */
export const checkFailed = signal(false);
/** The app couldn't tell how it was installed: no checks, and Settings says why. */
export const installUnknown = signal(false);

/** A newer release than this install is out. */
export const updateAvailable = computed<Release | null>(() => {
  const r = lastCheck.value.latest;
  const a = app.value;
  return r && a.fdroid === false && isNewer(r.version, a.version) ? r : null;
});

const store = kv;
/** When the last check failed (Date.now()), 0 after a success. */
let failedAt = 0;

/** Ask GitHub now. Resolves when done (a failure only sets `checkFailed`). */
export async function checkForUpdates(): Promise<void> {
  if (checking.peek() || app.peek().fdroid !== false) return;
  checking.value = true;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(LATEST_API, { headers: { Accept: 'application/vnd.github+json' }, signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const latest = releaseOf(await res.json());
    if (!latest) throw new Error('no stable release in the answer');
    lastCheck.value = { checkedAt: Date.now(), latest };
    checkFailed.value = false;
    failedAt = 0;
    void store.set(K_UPDATES, JSON.stringify(lastCheck.peek())).catch(() => {});
  } catch (e) {
    checkFailed.value = true;
    failedAt = Date.now();
    logError('update check', e);
  } finally {
    clearTimeout(timer);
    checking.value = false;
  }
}

/** Automatic check, if it's on and due (the real app only; the browser build is for tests). */
function maybeAutoCheck(): void {
  if (!Capacitor.isNativePlatform() || !settings.peek().checkUpdates) return;
  if (autoCheckDue(lastCheck.peek().checkedAt, Date.now(), failedAt)) void checkForUpdates();
}

let started = false;

/** What the native app says about this install (JukePlayer.getAppInfo). */
export type AppInfo = () => Promise<{ version: string; installer?: string }>;

/**
 * Once at startup (after the library has loaded): what this install is (`appInfo`, the real
 * app only), the saved check, then the automatic checks.
 */
export async function startUpdates(appInfo?: AppInfo): Promise<void> {
  if (started) return;
  started = true;
  if (appInfo) {
    try {
      const info = await appInfo();
      app.value = {
        version: info.version || __APP_VERSION__,
        fdroid: isFdroidInstaller(info.installer),
      };
    } catch (e) {
      // How it was installed is unknown: it stays so, and nothing asks GitHub.
      installUnknown.value = true;
      logError('getAppInfo', e);
    }
  }
  try {
    const saved = JSON.parse((await store.get(K_UPDATES)) ?? 'null') as Saved | null;
    if (saved && typeof saved.checkedAt === 'number') {
      const latest = saved.latest && typeof saved.latest.version === 'string' && typeof saved.latest.url === 'string' ? saved.latest : null;
      lastCheck.value = { checkedAt: saved.checkedAt, latest };
    }
  } catch {
    // A broken saved check: ask again.
  }
  maybeAutoCheck();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeAutoCheck();
  });
}
