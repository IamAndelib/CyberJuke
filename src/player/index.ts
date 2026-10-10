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
import { addRecent, recent, settings, showNsfw } from '../stores/library';
import { block } from '../stores/block';
import { catalog } from '../stores/catalog';
import { toast } from '../stores/toast';
import { auth } from '../data/auth';
import { music, musicTracks } from '../data/ytmusic';
import { logError } from '../core/log';
import { exposeForTests } from '../core/testHooks';
import { createAutoplay, type Autoplay } from './autoplay';
import { NativePlayer } from './nativePlayer';
import { safePlayer } from './safePlayer';
import { nsfwAutoplayIds, type PlayContext, type Player, type UpItem, type UpNextItem, type UpNextSections } from './types';
import { WebPlayer } from './webPlayer';

export * from './types';

/** A failed command's toast; during a block the banner says why, so the toast says so too. */
function commandFailed(message: string): void {
  toast(block.blocked.peek() ? 'Playback is paused while YouTube is limiting requests' : message);
}

export const player: Player = safePlayer(Capacitor.isNativePlatform() ? new NativePlayer() : new WebPlayer(), commandFailed);

const state = player.state;

/** The current track (same object until the track changes). */
export const currentTrack = computed(() => state.value.current);
export const currentId = computed(() => state.value.current?.id ?? null);
export const hasCurrent = computed(() => state.value.current != null);
export const isPlaying = computed(() => state.value.isPlaying);
export const isBuffering = computed(() => state.value.isBuffering);
/** Playing and not buffering: the position moves. */
export const isAdvancing = computed(() => state.value.isPlaying && !state.value.isBuffering);
export const shuffleOn = computed(() => state.value.shuffle);
export const repeatMode = computed(() => state.value.repeat);
/** The current track's length (0 until known). */
export const durationMs = computed(() => state.value.durationMs);
/** Where the current track is in the list: "3 of 50", or "Single track". */
export const queuePlace = computed(() => (state.value.queue.length > 1 ? `${state.value.index + 1} of ${state.value.queue.length}` : 'Single track'));
/** "Next" does something: a track after this one, or repeat wraps around. */
export const canSkipNext = computed(() => state.value.upNext.length > 0 || state.value.repeat !== 'off');

/** The context the current list was started with (C2); null before the first. Changes only with the list. */
export const playContext = computed<PlayContext | null>(() => state.value.context);

const NO_SECTIONS: UpNextSections = { queued: [], list: [], autoplay: [], seed: null };
let lastSections = NO_SECTIONS;

/**
 * Up next as its three sections (C2): queued by you, the rest of the list, autoplay; and
 * the track autoplay follows. The same object until one of them changes (never on a
 * position tick).
 */
export const upNextSections = computed<UpNextSections>(() => {
  const s = state.value;
  const next = sectionsOf(s.upNext, s.seed);
  if (sameSections(lastSections, next)) return lastSections;
  return (lastSections = next);
});

function sectionsOf(upNext: UpNextItem[], seed: UpNextSections['seed']): UpNextSections {
  const out: UpNextSections = { queued: [], list: [], autoplay: [], seed };
  for (const u of upNext) {
    const item: UpItem = { track: u.track, index: u.index };
    (u.queued ? out.queued : u.auto ? out.autoplay : out.list).push(item);
  }
  return out;
}

function sameItems(a: UpItem[], b: UpItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.track === b[i].track && x.index === b[i].index);
}

function sameSections(a: UpNextSections, b: UpNextSections): boolean {
  return a.seed === b.seed && sameItems(a.queued, b.queued) && sameItems(a.list, b.list) && sameItems(a.autoplay, b.autoplay);
}

// e2e: what Up next holds, with the fields similarity works on.
exposeForTests('__cyberjukeQueue', () => {
  const s = state.peek();
  const sec = upNextSections.peek();
  const t = (x: { id: string; title: string; artist: string; genre: string; by: string; source?: string } | null) =>
    x && { id: x.id, title: x.title, artist: x.artist, genre: x.genre, by: x.by, source: x.source ?? 'jukebox' };
  const items = (xs: UpItem[]) => xs.map((u) => t(u.track));
  return { context: s.context, current: t(s.current), seed: t(sec.seed), queued: items(sec.queued), list: items(sec.list), autoplay: items(sec.autoplay) };
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
  if (cur && cur.ytId && isPlaying.value && cur.id !== lastRecentId) {
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
    radio: (ytId, next) => music.radio(ytId, next).then((page) => ({ tracks: musicTracks(page.items), next: page.next })),
    log: logError,
  });
  const a = autoplay;
  // A list started before the catalog loaded gets its autoplay once it has.
  effect(() => {
    if (catalog.tracks.value.length) untracked(() => a.catalogReady());
  });
  return autoplay;
}

/**
 * Send the player settings (audio quality, the Y6 IPv4 setting, Autoplay) to the player now
 * and on every change, and start autoplay. Called once the library has loaded, so native
 * never gets the defaults first.
 */
export function startPlayerPrefs(): void {
  let lastQuality: string | null = null;
  let lastIpv4: string | null = null;
  let lastAutoplay: boolean | null = null;
  startAutoplay();
  effect(() => {
    const { quality, ipv4 } = settings.value;
    const auto = settings.value.autoplay;
    // Only the settings are followed: what the player calls read (its state) isn't.
    untracked(() => {
      if (quality !== lastQuality) {
        lastQuality = quality;
        void player.setQuality(quality);
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

let purging = false;

/** The queue holds a members-only track (recomputed only when the list itself changes). */
const queueList = computed(() => state.value.queue);
const queuedMembersOnly = computed(() => queueList.value.some((t) => t.membersOnly));

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
}
