/**
 * Player facade. On Android the native JukePlayer plugin plays audio (and owns the
 * queue). In the browser the web player drives the YouTube IFrame API, which only the
 * e2e stub provides (the CSP blocks the real embed). Every command goes
 * through safePlayer (a failure is a toast, never an unhandled rejection).
 *
 * Components read the narrow computeds below rather than `player.state`, so a
 * position sample (every second while playing) re-renders nothing but what shows
 * the position.
 */
import { Capacitor } from '@capacitor/core';
import { computed, effect, untracked } from '@preact/signals';
import { addRecent, likedIds, recent, settings, showNsfw } from '../stores/library';
import { block } from '../stores/block';
import { offlinePlays } from '../stores/local';
import { catalog } from '../stores/catalog';
import { toast } from '../stores/toast';
import { auth } from '../data/auth';
import { music, musicTracks } from '../data/ytmusic';
import { hasAudio } from '../core/guards';
import { logError } from '../core/log';
import { heldFor } from '../core/held';
import { online } from '../core/network';
import { OFFLINE } from '../core/offlineText';
import { exposeForTests } from '../core/testHooks';
import { isLocal, type Track } from '../data/model';
import { isSaved, savedOffline, savedTracks } from '../stores/savedOffline';
import { createAutoplay, shuffleGenre, type Autoplay } from './autoplay';
import { NativePlayer } from './nativePlayer';
import { offlineGuard, playsOffline, type OfflineRefusal } from './offlineGuard';
import { stationPlaying } from './radio';
import { safePlayer } from './safePlayer';
import { nsfwAutoplayIds, placeOf, sectionsOf, wantsPlay, type PlayContext, type Player, type UpItem, type UpNextSections } from './types';
import { WebPlayer } from './webPlayer';

export * from './types';
export { shuffleLabel } from './autoplay';

/** A failed command's toast; during a block the banner says why, so the toast says so too. */
function commandFailed(message: string): void {
  toast(block.blocked.peek() ? 'Playback is paused while YouTube is limiting requests' : message);
}

/** Opens Library (the app sets it: the player can't reach the screens). */
let openLibrary: (() => void) | null = null;

/** Where the offline toast's Library button (and the offline line, ui/components/OfflineLine) goes. */
export function setOpenLibrary(open: () => void): void {
  openLibrary = open;
}

/** Opens Library's list (closing Now Playing first): for screens that can't import the Library. */
export function goToLibrary(): void {
  openLibrary?.();
}

/**
 * Says why playing was refused offline. With songs that still play (liked songs saved, local
 * songs): a liked song not saved yet says so; anything else names what still plays (its button
 * opens Library). With none, that it needs a connection.
 */
function refuseOffline(why: OfflineRefusal): void {
  const plays = offlinePlays.peek();
  if (!plays) toast(OFFLINE.tap);
  else if (why === 'unsaved') toast(OFFLINE.notSaved);
  else toast(OFFLINE.tapPlays(plays), undefined, openLibrary ? { label: OFFLINE.libraryAction, run: openLibrary } : undefined);
}

/**
 * Whether playback can start now, for something that isn't a saved liked song (the Jukebox
 * shuffle). Offline it says why (a toast) and returns false.
 */
export function canStartPlayback(): boolean {
  if (online.peek()) return true;
  refuseOffline('offline');
  return false;
}

/**
 * What of `tracks` can play now: all of it online; offline only its saved songs (from any list).
 * Null (and a toast says why) when none can. For actions made of several commands (Play and
 * Shuffle), before their first one.
 */
export function playableNow(tracks: Track[]): Track[] | null {
  if (online.peek()) return tracks;
  const some = savedTracks(tracks, savedOffline.peek());
  if (some.length) return some;
  refuseOffline('offline');
  return null;
}

const guarded = offlineGuard(safePlayer(Capacitor.isNativePlatform() ? new NativePlayer() : new WebPlayer(), commandFailed), {
  online: () => online.peek(),
  saved: () => savedOffline.peek(),
  liked: (t) => likedIds.peek().has(t.id),
  refuse: refuseOffline,
});

/** Tracks removed from Up next this session: autoplay doesn't pick them again (Spotify, YouTube Music). Undo puts one back. */
const removed = new Set<string>();

export const player: Player = {
  ...guarded,
  remove: (index, expectId) => {
    const t = guarded.state.peek().queue[index];
    if (t && (expectId == null || t.id === expectId)) removed.add(t.id);
    return guarded.remove(index, expectId);
  },
  restore: (track, kind, beforeId, mine) => {
    removed.delete(track.id);
    return guarded.restore(track, kind, beforeId, mine);
  },
};

const state = player.state;

/** The current track (same object until the track changes). */
export const currentTrack = computed(() => state.value.current);
export const currentId = computed(() => state.value.current?.id ?? null);
/** The current track came from autoplay. */
export const currentAuto = computed(() => state.value.currentAuto);
export const hasCurrent = computed(() => state.value.current != null);
export const isPlaying = computed(() => state.value.isPlaying);
export const isBuffering = computed(() => state.value.isBuffering);
/** Playing and not buffering: the position moves. */
export const isAdvancing = computed(() => state.value.isPlaying && !state.value.isBuffering);
/** The play/pause button shows Pause ([wantsPlay]). */
export const playWanted = computed(() => wantsPlay(state.value));
/**
 * The connection dropped and the music waits for it; native resumes by itself once it's back.
 * Shown once it has held for a moment: a saved song starting offline buffers from the cache for
 * a split second too, and a handover is checked for up to a second.
 */
const WAITING_SHOW_MS = 1000;
export const waitingForNetwork = heldFor(
  computed(() => state.value.waitingForNetwork),
  WAITING_SHOW_MS,
);
/**
 * Offline, the current track still plays (saved, audio loaded ahead, or playing): its row isn't
 * dimmed and Play goes through. The same rule as the player's offline guard.
 */
export const currentPlaysOffline = computed(() => playsOffline(state.value, savedOffline.value));
export const shuffleOn = computed(() => state.value.shuffle);
export const repeatMode = computed(() => state.value.repeat);
/** The current track's length (0 until known). */
export const durationMs = computed(() => state.value.durationMs);
/** Where the current track is in the list you started (placeOf). */
export const queuePlace = computed(() => placeOf(state.value));
/** "Next" does something: a track after this one, or repeat wraps around. */
export const canSkipNext = computed(() => state.value.upNext.length > 0 || state.value.repeat === 'all');

/** The context the current list was started with (C2); null before the first. Changes only with the list. */
export const playContext = computed<PlayContext | null>(() => state.value.context);

const NO_SECTIONS: UpNextSections = { queued: [], list: [], autoplay: [], runs: [], seed: null };
let lastSections = NO_SECTIONS;

/**
 * Up next as its sections (C2, sectionsOf): queued by you, the rest of the list, autoplay; and
 * the track autoplay follows. The same object until a row or the seed changes (never on a
 * position tick).
 */
export const upNextSections = computed<UpNextSections>(() => {
  const s = state.value;
  const next = sectionsOf(s.upNext, s.seed);
  if (sameSections(lastSections, next)) return lastSections;
  return (lastSections = next);
});

let lastPrevious: UpItem[] = [];

/** The tracks before the current one in play order, oldest first (Up next shows them above it). The same array until they change. */
export const previousTracks = computed<UpItem[]>(() => {
  const next = state.value.previous.map((u) => ({ track: u.track, index: u.index }));
  return sameItems(lastPrevious, next) ? lastPrevious : (lastPrevious = next);
});

let lastLap: UpItem[] = [];

/** The next lap ("From the top"), with repeat all: the play order from its first song up to the one before the current, without the songs you queued. The same array until it changes. */
export const lapTracks = computed<UpItem[]>(() => {
  const next = state.value.lap.map((u) => ({ track: u.track, index: u.index }));
  return sameItems(lastLap, next) ? lastLap : (lastLap = next);
});

/**
 * What autoplay's tracks are, for Up next's heading and Now Playing while one plays: a station's
 * next rounds, a Jukebox shuffle's more random picks, or songs similar to the seed.
 */
export const autoplayLabel = computed(() => {
  const ctx = playContext.value;
  const seed = upNextSections.value.seed;
  const station = stationPlaying(ctx, seed?.id);
  if (station) return `More from ${station.callsign}`;
  const genre = shuffleGenre(ctx?.label);
  if (genre !== undefined) return `More random picks from ${genre ?? 'the Jukebox'}`;
  return seed?.title ? `Autoplay · similar to ${seed.title}` : 'Autoplay';
});


function sameItems(a: UpItem[], b: UpItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.track === b[i].track && x.index === b[i].index);
}

function sameSections(a: UpNextSections, b: UpNextSections): boolean {
  return a.seed === b.seed && a.runs.length === b.runs.length && a.runs.every((r, k) => r.kind === b.runs[k].kind && sameItems(r.items, b.runs[k].items));
}

// e2e: what Up next holds, with the fields similarity works on.
exposeForTests('__cyberjukeQueue', () => {
  const s = state.peek();
  const sec = upNextSections.peek();
  const t = (x: { id: string; title: string; artist: string; genre: string; by: string; source?: string } | null) =>
    x && { id: x.id, title: x.title, artist: x.artist, genre: x.genre, by: x.by, source: x.source ?? 'jukebox' };
  const items = (xs: UpItem[]) => xs.map((u) => t(u.track));
  return {
    context: s.context,
    current: t(s.current),
    seed: t(sec.seed),
    previous: items(s.previous),
    queued: items(sec.queued),
    list: items(sec.list),
    autoplay: items(sec.autoplay),
    top: s.lap.map((u) => u.track.id),
    mine: s.mine.map((i) => s.queue[i].id),
  };
});

interface PositionSample {
  positionMs: number;
  durationMs: number;
  sampledAt: number;
  isPlaying: boolean;
  isBuffering: boolean;
}

/** The latest position sample (changes about once a second while playing). Read it in effects, not render. */
export const positionSample = computed<PositionSample>(() => {
  const s = state.value;
  return { positionMs: s.positionMs, durationMs: s.durationMs, sampledAt: s.sampledAt, isPlaying: s.isPlaying, isBuffering: s.isBuffering };
});

let lastRecentId: string | null = null;
// Recently played: a track once it plays (not the one the app reopens on, paused).
effect(() => {
  const cur = currentTrack.value;
  if (cur && hasAudio(cur) && isPlaying.value && cur.id !== lastRecentId) {
    lastRecentId = cur.id;
    addRecent(cur);
  }
});

/** The Autoplay setting (C3); on unless turned off. */
let autoplay: Autoplay | null = null;

/** Start autoplay (AP4): it answers the player's "running low" signals. Once. */
function startAutoplay(): Autoplay {
  autoplay ??= createAutoplay({
    player,
    catalog: () => catalog.tracks.peek(),
    history: () => recent.peek(),
    showNsfw: () => showNsfw.peek(),
    signedIn: () => auth.signedIn(),
    blocked: () => block.blocked.peek() != null,
    removed: () => removed,
    playable: (t) => online.peek() || isSaved(t, savedOffline.peek()),
    radio: (ytId, next) => music.radio(ytId, next).then((page) => ({ tracks: musicTracks(page.items), next: page.next })),
    log: logError,
  });
  const a = autoplay;
  // A list started before the catalog loaded, or before the player's state came (a reloaded
  // page), gets its autoplay once both have.
  effect(() => {
    if (catalog.tracks.value.length && currentId.value) untracked(() => a.ready());
  });
  return autoplay;
}

/**
 * Send the player settings (audio quality, crossfade, gapless, the Y6 IPv4 setting, Autoplay)
 * to the player now and on every change, and start autoplay. Called once the library has
 * loaded, so native never gets the defaults first.
 */
export function startPlayerPrefs(): void {
  let lastQuality: string | null = null;
  let lastCrossfade: number | null = null;
  let lastGapless: boolean | null = null;
  let lastIpv4: string | null = null;
  let lastAutoplay: boolean | null = null;
  startAutoplay();
  effect(() => {
    const { quality, crossfadeMs, gapless, ipv4 } = settings.value;
    const auto = settings.value.autoplay;
    // Only the settings are followed: what the player calls read (its state) isn't.
    untracked(() => {
      if (quality !== lastQuality) {
        lastQuality = quality;
        void player.setQuality(quality);
      }
      if (crossfadeMs !== lastCrossfade) {
        lastCrossfade = crossfadeMs;
        void player.setCrossfade(crossfadeMs);
      }
      if (gapless !== lastGapless) {
        lastGapless = gapless;
        void player.setGapless(gapless);
      }
      if (ipv4 !== lastIpv4) {
        lastIpv4 = ipv4;
        void player.setNetworkPrefs({ ipv4 });
      }
      if (auto !== lastAutoplay) {
        lastAutoplay = auto;
        void player.setAutoplay(auto);
      }
    });
  });
}

/** Signed out: members-only tracks leave the queue (K5, S8). */
function dropMembersFromQueue(): Promise<void> {
  const ids = [...new Set(state.peek().queue.filter((t) => t.membersOnly).map((t) => t.id))];
  return ids.length ? player.removeIds(ids) : Promise.resolve();
}

/** NSFW turned off: the NSFW picks autoplay already queued go (what you chose yourself stays). */
function dropNsfwAutoplay(): Promise<void> {
  const ids = nsfwAutoplayIds(state.peek().upNext);
  return ids.length ? player.removeIds(ids) : Promise.resolve();
}

/** Local music turned off: its songs leave the queue (they can't play any more). */
function dropLocalFromQueue(): Promise<void> {
  const ids = [...new Set(state.peek().queue.filter(isLocal).map((t) => t.id))];
  return ids.length ? player.removeIds(ids) : Promise.resolve();
}

let purging = false;

/** The queue holds a members-only track (recomputed only when the list itself changes). */
const queueList = computed(() => state.value.queue);
const queuedMembersOnly = computed(() => queueList.value.some((t) => t.membersOnly));
const queuedLocal = computed(() => queueList.value.some(isLocal));
const localMusic = computed(() => settings.value.localMusic);

/** Follow sign-outs and the NSFW setting for the queue (call once at startup). */
export function startQueuePurge(): void {
  if (purging) return;
  purging = true;
  // Signed out with members-only tracks queued: on signing out, and at startup (the app
  // reopens on the last session, which may be from before a sign-out).
  effect(() => {
    if (auth.state.value.status === 'signedOut' && queuedMembersOnly.value) untracked(() => void dropMembersFromQueue());
  });
  let nsfwWas = showNsfw.peek();
  effect(() => {
    const nsfw = showNsfw.value;
    if (nsfwWas && !nsfw) untracked(() => void dropNsfwAutoplay());
    nsfwWas = nsfw;
  });
  // Local music off with local songs queued: on turning it off, and at startup.
  effect(() => {
    if (!localMusic.value && queuedLocal.value) untracked(() => void dropLocalFromQueue());
  });
}
