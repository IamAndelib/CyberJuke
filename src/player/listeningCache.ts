/**
 * The native listening cache: the audio of recently played and next tracks, and of liked songs,
 * on the phone only, up to the size chosen in Settings. Liked songs are saved so they play
 * offline (`savedOffline`). This wires the page's side of it:
 *  - the liked songs (newest like first), sent at start and when Liked changes (a burst of
 *    likes sends once);
 *  - the size setting, sent at start and on change, and Clear cache;
 *  - signing out drops the cached audio of members-only tracks;
 *  - which liked songs are saved: asked at start, then native says when that changes.
 * In the browser there is no cache: nothing is saved (dev/test builds expose
 * `window.__cyberjukeCache` so the e2e suite can say what is, and record the calls).
 */
import { Capacitor } from '@capacitor/core';
import { effect } from '@preact/signals';
import { YT_ID_RE } from '../core/guards';
import { logError } from '../core/log';
import { TEST_HOOKS, exposeForTests } from '../core/testHooks';
import type { Track } from '../data/model';
import { catalog } from '../stores/catalog';
import { liked, onMembersOnlyDropped, settings, type CacheMb } from '../stores/library';
import { setSavedOffline } from '../stores/savedOffline';
import { BRIDGE_MAX_ITEMS, JukePlayer } from './native';
import { player } from './index';

/** A burst of likes (or Undo) sends the list once, this long after the last change. */
export const LIKED_SEND_DELAY_MS = 1000;

const native = Capacitor.isNativePlatform();
const fail = (where: string) => (e: unknown) => logError(where, e);

/** Browser (dev/test builds): what native would have been asked. */
function record(call: unknown[]): void {
  if (TEST_HOOKS) window.__cyberjukePlayerCalls?.push(call);
}

/** The ytIds of `tracks` native takes: valid, each once, in order, at most BRIDGE_MAX_ITEMS. */
export function ytIdsOf(tracks: readonly Track[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tracks) {
    if (out.length >= BRIDGE_MAX_ITEMS) break;
    if (!YT_ID_RE.test(t.ytId) || seen.has(t.ytId)) continue;
    seen.add(t.ytId);
    out.push(t.ytId);
  }
  return out;
}

function sendLiked(ytIds: string[]): void {
  if (native) JukePlayer.setLikedIds({ ytIds }).catch(fail('cache.setLikedIds'));
  else record(['setLikedIds', ytIds]);
}

function sendLimit(mb: CacheMb): void {
  if (native) JukePlayer.setCacheLimit({ mb }).catch(fail('cache.setCacheLimit'));
  else record(['setCacheLimit', { mb }]);
}

/** Signed out: the audio of these members-only videos goes (BRIDGE_MAX_ITEMS a call). */
function dropCached(ytIds: string[]): void {
  for (let i = 0; i < ytIds.length; i += BRIDGE_MAX_ITEMS) {
    const ids = ytIds.slice(i, i + BRIDGE_MAX_ITEMS);
    if (native) JukePlayer.dropCached({ ytIds: ids }).catch(fail('cache.dropCached'));
    else record(['dropCached', ids]);
  }
}

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
  effect(() => {
    const ids = ytIdsOf(liked.value);
    const key = ids.join(',');
    if (key === sent) return;
    if (timer) clearTimeout(timer);
    if (sent === null) {
      sent = key;
      sendLiked(ids);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      sent = key;
      sendLiked(ids);
    }, LIKED_SEND_DELAY_MS);
  });

  let lastMb: CacheMb | null = null;
  effect(() => {
    const mb = settings.value.cacheMb;
    if (mb === lastMb) return;
    lastMb = mb;
    sendLimit(mb);
  });

  // Signed out: the members-only tracks it drops from Liked and history, and those still in the
  // queue or the catalog (played, or loaded ahead, without being liked or played to the end).
  onMembersOnlyDropped((dropped) => {
    const queued = player.state.peek().queue;
    const members = [...dropped, ...queued, ...catalog.all.peek()].filter((t) => t.membersOnly);
    const ids = ytIdsOfAll(members);
    if (ids.length) dropCached(ids);
  });

  if (!native) {
    exposeForTests('__cyberjukeCache', { saved: (ytIds: string[]) => setSavedOffline(ytIds) });
    return;
  }
  JukePlayer.addListener('cacheChanged', (e) => setSavedOffline(Array.isArray(e?.ytIds) ? e.ytIds : [])).catch(fail('cache.listen'));
  JukePlayer.cachedIds()
    .then((r) => setSavedOffline(Array.isArray(r?.ytIds) ? r.ytIds : []))
    .catch(fail('cache.cachedIds'));
}

/** Like ytIdsOf, without the cap (dropCached sends them in parts). */
function ytIdsOfAll(tracks: readonly Track[]): string[] {
  return [...new Set(tracks.map((t) => t.ytId).filter((id) => YT_ID_RE.test(id)))];
}
