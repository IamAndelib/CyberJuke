/**
 * The native listening cache: the audio of recently played and next tracks, and of liked songs,
 * on the phone only, up to the size chosen in Settings. Liked songs are saved so they play
 * offline (`savedOffline`). This wires the page's side of it:
 *  - the liked songs (newest like first) and which are members-only, sent at start and when
 *    Liked changes (a burst of likes sends once); none while Liked couldn't be read (native
 *    keeps the Liked it has rather than hear that this session's likes are all of it);
 *  - the size setting, sent at start and on change, and Clear cache;
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
import type { Track } from '../data/model';
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

/** What setLikedIds sends for `tracks`: their audio ids (in `ytIds`, the bridge's name), and the members-only ones among them. */
export function likedPayload(tracks: readonly Track[]): { ytIds: string[]; membersOnly: string[] } {
  const ytIds = audioIdsOf(tracks);
  const sent = new Set(ytIds);
  const membersOnly = audioIdsOf(tracks.filter((t) => t.membersOnly && sent.has(audioIdOf(t))));
  return { ytIds, membersOnly };
}

/** Native's `name` call, or in the browser a record of it (with `shown`, what the e2e suite checks). */
function send(name: string, call: () => Promise<unknown>, ...shown: unknown[]): void {
  if (native) call().catch(fail(`cache.${name}`));
  else record([name, ...shown]);
}

const sendLiked = (o: { ytIds: string[]; membersOnly: string[] }) => send('setLikedIds', () => JukePlayer.setLikedIds(o), o.ytIds);
const sendLimit = (mb: CacheMb) => send('setCacheLimit', () => JukePlayer.setCacheLimit({ mb }), { mb });
const sendSignedOut = () => send('signedOut', () => JukePlayer.signedOut());
const sendSignedIn = () => send('signedIn', () => JukePlayer.signedIn());

/** Settings' Clear cache: everything goes; playback goes on, and liked songs are saved again on Wi-Fi. */
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
  const send = (o: { ytIds: string[]; membersOnly: string[] }, key: string) => {
    if (timer) clearTimeout(timer);
    timer = null;
    sent = key;
    sendLiked(o);
  };
  const keyOf = (o: { ytIds: string[]; membersOnly: string[] }) => o.ytIds.join(',') + '|' + o.membersOnly.join(',');
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
  JukePlayer.addListener('cacheChanged', (e) => setSavedOffline(Array.isArray(e?.ytIds) ? e.ytIds : [])).catch(fail('cache.listen'));
  JukePlayer.cachedIds()
    .then((r) => setSavedOffline(Array.isArray(r?.ytIds) ? r.ytIds : []))
    .catch(fail('cache.cachedIds'));
}
