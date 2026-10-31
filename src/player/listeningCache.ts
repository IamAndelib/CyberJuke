/**
 * The native listening cache: the audio of recently played and next tracks, on the phone only,
 * up to the size chosen in Settings. Liked songs are saved so they play offline (`savedOffline`),
 * in a space of their own that the size doesn't cover. This wires the page's side of it:
 *  - the liked songs (newest like first) and which are members-only, sent at start and when
 *    Liked changes (a burst of likes sends once); none while Liked couldn't be read (native
 *    keeps the Liked it has rather than hear that this session's likes are all of it);
 *  - the size and Download using mobile data settings, sent at start and on change, and Clear cache;
 *  - signing out (and starting signed out): Liked at once, then `signedOut()`, so native drops
 *    every members-only track's audio and caches none until a sign-in;
 *  - which liked songs are saved: asked at start, then native says when that changes.
 * In the browser there is no cache: nothing is saved (dev/test builds expose
 * `window.__cyberjukeCache` so the e2e suite can say what is, and record the calls).
 */
import { Capacitor } from '@capacitor/core';
import { effect } from '@preact/signals';
import { audioIdOf } from '../core/guards';
import { logError } from '../core/log';
import { TEST_HOOKS, exposeForTests } from '../core/testHooks';
import { auth } from '../data/auth';
import { isCoverUrl, type Track } from '../data/model';
import { liked, likedUnreadable, onMembersOnlyDropped, settings, type CacheMb } from '../stores/library';
import { setSavedOffline } from '../stores/savedOffline';
import { BRIDGE_MAX_ITEMS, JukePlayer } from './native';

/** A burst of likes (or Undo) sends the list once, this long after the last change. */
export const LIKED_SEND_DELAY_MS = 1000;

const native = Capacitor.isNativePlatform();
const fail = (where: string) => (e: unknown) => logError(where, e);

/** Browser (dev/test builds): what native would have been asked. */
function record(call: unknown[]): void {
  if (TEST_HOOKS) window.__cyberjukePlayerCalls?.push(call);
}

/**
 * The audio ids of `tracks` native takes (audioIdOf: a video id, or `mp3:<file>` for a Jukebox
 * MP3): valid, each once, in order, at most BRIDGE_MAX_ITEMS.
 */
export function audioIdsOf(tracks: readonly Track[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tracks) {
    if (out.length >= BRIDGE_MAX_ITEMS) break;
    const id = audioIdOf(t);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export type LikedPayload = { ytIds: string[]; membersOnly: string[]; covers: Record<string, string> };

/**
 * What setLikedIds sends for `tracks`: their audio ids (in `ytIds`, the bridge's name), the
 * members-only ones among them, and a Jukebox MP3's cover by its audio id (native keeps it with
 * the saved song, so it shows offline; a video's frames it knows from its id).
 */
export function likedPayload(tracks: readonly Track[]): LikedPayload {
  const ytIds = audioIdsOf(tracks);
  const sent = new Set(ytIds);
  const membersOnly = audioIdsOf(tracks.filter((t) => t.membersOnly && sent.has(audioIdOf(t))));
  const covers: Record<string, string> = {};
  for (const t of tracks) {
    const id = audioIdOf(t);
    if (id && !t.ytId && sent.has(id) && isCoverUrl(t.artworkUrl)) covers[id] ??= t.artworkUrl;
  }
  return { ytIds, membersOnly, covers };
}

/** Native's `name` call, or in the browser a record of it (with `shown`, what the e2e suite checks). */
function send(name: string, call: () => Promise<unknown>, ...shown: unknown[]): void {
  if (native) call().catch(fail(`cache.${name}`));
  else record([name, ...shown]);
}

const sendLiked = (o: LikedPayload) => send('setLikedIds', () => JukePlayer.setLikedIds(o), o.ytIds);
const sendLimit = (mb: CacheMb) => send('setCacheLimit', () => JukePlayer.setCacheLimit({ mb }), { mb });
const sendMobileData = (enabled: boolean) => send('setDownloadOnMobileData', () => JukePlayer.setDownloadOnMobileData({ enabled }), { enabled });
const sendSignedOut = () => send('signedOut', () => JukePlayer.signedOut());
const sendSignedIn = () => send('signedIn', () => JukePlayer.signedIn());

/** Settings' Clear cache: the recent songs go, the saved liked songs stay; playback goes on. */
export function clearListeningCache(): Promise<void> {
  if (!native) {
    record(['clearCache']);
    return Promise.resolve();
  }
  return JukePlayer.clearCache();
}

let started = false;

/** Call once at startup, after the library has loaded (so native never gets an empty Liked first). */
export function startListeningCache(): void {
  if (started) return;
  started = true;

  // Liked, newest like first: at once, then a short while after the last change.
  let sent: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = (o: LikedPayload, key: string) => {
    if (timer) clearTimeout(timer);
    timer = null;
    sent = key;
    sendLiked(o);
  };
  const keyOf = (o: LikedPayload) => o.ytIds.join(',') + '|' + o.membersOnly.join(',') + '|' + Object.values(o.covers).join(',');
  effect(() => {
    if (likedUnreadable.value) return;
    const o = likedPayload(liked.value);
    const key = keyOf(o);
    if (key === sent) {
      if (timer) clearTimeout(timer);
      timer = null;
      return;
    }
    if (sent === null) return send(o, key);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => send(o, key), LIKED_SEND_DELAY_MS);
  });

  let lastMb: CacheMb | null = null;
  effect(() => {
    const mb = settings.value.cacheMb;
    if (mb === lastMb) return;
    lastMb = mb;
    sendLimit(mb);
  });

  let lastMobileData: boolean | null = null;
  effect(() => {
    const on = settings.value.downloadOnMobileData;
    if (on === lastMobileData) return;
    lastMobileData = on;
    sendMobileData(on);
  });

  // Signed out (or starting signed out), the members-only tracks just left Liked: native hears
  // the new Liked first, at once, then drops all members-only audio.
  onMembersOnlyDropped(() => {
    if (!likedUnreadable.peek()) {
      const o = likedPayload(liked.peek());
      send(o, keyOf(o));
    }
    sendSignedOut();
  });
  if (auth.signedIn()) sendSignedIn();
  auth.onChange((signedIn) => {
    if (signedIn) sendSignedIn();
  });

  if (!native) {
    exposeForTests('__cyberjukeCache', { saved: (audioIds: string[]) => setSavedOffline(audioIds) });
    return;
  }
  // Each report is the whole set. The first answer can be read before a change and arrive
  // after its `cacheChanged`: then it is older, and dropped (a later change sends the set again).
  let changed = false;
  JukePlayer.addListener('cacheChanged', (e) => {
    changed = true;
    setSavedOffline(Array.isArray(e?.ytIds) ? e.ytIds : []);
  }).catch(fail('cache.listen'));
  JukePlayer.cachedIds()
    .then((r) => changed || setSavedOffline(Array.isArray(r?.ytIds) ? r.ytIds : []))
    .catch(fail('cache.cachedIds'));
}
