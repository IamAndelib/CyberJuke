/**
 * Contract with the native Kotlin `JukePlayer` Capacitor plugin.
 * The native engineer implements exactly this; do not change it unilaterally.
 */
import { registerPlugin } from '@capacitor/core';
import type { CrossfadeMs, Quality } from '../stores/library';

/**
 * `album`: the album the track was opened from (Track.album), for the same-album rule of
 * Crossfade. Native keeps it with the last session and echoes it in `tracks`.
 * `mp3`: a Jukebox MP3 (Track.mp3, a latex.gg share link matching MP3_URL_RE), played
 * from that URL; its `ytId` is ''. Native keeps it with the last session and echoes it.
 * `artworkUrl` is then the post's cover (https://bunker.cyberspace.online/uploads/…).
 */
export interface NativeTrack { id: string; ytId: string; title: string; artist: string; artworkUrl: string; by?: string; postUrl?: string; membersOnly?: boolean; album?: string; mp3?: string }
export type RepeatMode = 'off' | 'all' | 'one';
export interface NativeState {
  /**
   * isPlaying: playing or about to, as Media3's play/pause button shows it (Util.shouldShowPlayButton),
   * so also while it loads; isBuffering: it is loading.
   */
  isPlaying: boolean; isBuffering: boolean;
  index: number;            // index into the current list (list order), -1 if empty
  trackId: string | null;
  positionMs: number; durationMs: number;   // durationMs 0 if unknown
  shuffle: boolean; repeat: RepeatMode;
  queueIds: string[];       // the full current list, in list order (omitted with queueIdsUnchanged)
  /** True when the list didn't change since the last event: queueIds is then omitted, keep the previous one. */
  queueIdsUnchanged?: boolean;
  upNextIds: string[];      // the next tracks in actual play order (respects shuffle), max 50
  /** One letter per upNextIds entry: q = queued by you, l = the list, a = autoplay. */
  upNextKinds: string;
  /**
   * K1: per upNextIds entry, its index in the list (always sent, also with
   * queueIdsUnchanged). Up next rows are addressed by these, never by id.
   */
  upNextIndex: number[];
  /** The context the current list was started with (C2), null before the first. */
  context: { label: string; mode: 'radio' | 'list' } | null;
  /** The track autoplay follows (the started track, or the autoplay track tapped). */
  seedId: string | null;
  /**
   * The connection dropped and playback paused; it resumes by itself once the network is back
   * (within a few minutes). Sent again whenever it changes. Absent from older natives: false.
   */
  waitingForNetwork?: boolean;
  /**
   * How much of the current track is loaded past the position, in ms: bufferedPosition minus
   * position, at least 0 (a restored session not loaded yet has none). Absent from older natives: 0.
   */
  bufferedAheadMs?: number;
}
/** Why YouTube is refusing requests from this network (Y1). */
export type BlockReason = 'BOT_CHECK' | 'RATE_LIMIT' | 'STREAM_FORBIDDEN';
export interface BlockedEvent { until: number /* epoch ms */; reason: BlockReason }
/** K6: the most tracks (or ids) one call may carry, and the longest string; more is TOO_LARGE. */
export const BRIDGE_MAX_ITEMS = 2000;
export const BRIDGE_MAX_STRING = 2000;
/**
 * K2: skipToIndex, removeItem and moveItem reject with this code (changing nothing)
 * when the item at the index isn't `expectId`.
 */
export const STALE_INDEX = 'STALE_INDEX';
/**
 * setQueue, queueNext and addAutoplay reject the whole call ("Invalid tracks: track.ytId
 * invalid") when a track has neither a ytId of 11 characters of [A-Za-z0-9_-] nor (with
 * ytId '') an `mp3` matching MP3_URL_RE: filter before calling (hasAudio).
 * More than BRIDGE_MAX_ITEMS tracks, or a string over BRIDGE_MAX_STRING, is TOO_LARGE.
 * While blocked, setQueue replaces the queue without preparing it (and resolves), and
 * play() is refused when nothing is loaded. trackError is never sent for blocks.
 */
interface JukePlayerPlugin {
  /** A new list. Tracks queued with queueNext stay next (P1); autoplay starts over from the start track (a Global one gets its radio natively). */
  setQueue(o: { tracks: NativeTrack[]; startIndex: number; positionMs?: number; playWhenReady: boolean; context?: { label: string; mode: 'radio' | 'list' } }): Promise<void>;
  /** Jukebox autoplay picks for `seedId` (after queueLow); dropped if the seed changed, autoplay is off or repeat is on. */
  addAutoplay(o: { tracks: NativeTrack[]; seedId: string }): Promise<void>;
  /** The Autoplay setting; off drops the autoplay tracks still to come. */
  setAutoplay(o: { enabled: boolean }): Promise<void>;
  /** Insert after the current track + tracks already user-queued; respects shuffle; upNextIds reflects it. */
  queueNext(o: { tracks: NativeTrack[] }): Promise<void>;
  /** K3: Undo of a remove, back in its section before `beforeId` (else at the section's end), never at or before the current track. */
  restore(o: { track: NativeTrack; kind: 'queued' | 'list' | 'autoplay'; beforeId: string | null }): Promise<void>;
  /** K5: remove every item with one of these ids (at most BRIDGE_MAX_ITEMS); the current one skips to the next that stays, or stops. */
  removeIds(o: { ids: string[] }): Promise<void>;
  removeItem(o: { index: number; expectId?: string }): Promise<void>;
  /** expectId: the id at `from`. */
  moveItem(o: { from: number; to: number; expectId?: string }): Promise<void>;
  play(): Promise<void>; pause(): Promise<void>;
  seekTo(o: { positionMs: number }): Promise<void>;
  skipToNext(): Promise<void>; skipToPrevious(): Promise<void>;
  /** A tap in Up next: queued tracks stay next; on an autoplay track the radio continues from it. */
  skipToIndex(o: { index: number; expectId?: string }): Promise<void>;
  setShuffle(o: { enabled: boolean }): Promise<void>;
  setRepeat(o: { mode: RepeatMode }): Promise<void>;
  /**
   * 'auto' steps down a notch after two stalls within 3 minutes and back up after 5 calm minutes,
   * only between tracks (QualityGovernor); an unknown value is 'auto'.
   */
  setQuality(o: { quality: Quality }): Promise<void>;
  /**
   * Crossfade: 0 (Off) or the fade, in ms, between tracks that end by themselves (not on a
   * skip or an outage; on Repeat one into the track's own start; shrunk on short tracks). Saved
   * natively; anything else rejects.
   */
  setCrossfade(o: { ms: CrossfadeMs }): Promise<void>;
  /**
   * Gapless playback (Settings, on by default). On, the next track is resolved and buffered
   * while this one plays and ExoPlayer's own transition is seamless; with Crossfade on, two
   * tracks of the same album (NativeTrack.album) go straight into each other instead of fading.
   * Off, the next track is prepared but not buffered until it becomes current (a skip costs
   * little data for it; a short pause as it starts), unless Crossfade is on. Saved natively.
   */
  setGapless(o: { enabled: boolean }): Promise<void>;
  getState(): Promise<NativeState>;
  /** From an Android intent extra (debuggable builds), used by the CI smoke test. */
  getLaunchOptions(): Promise<{ autoplay?: 'latest' }>;
  /** The installed versionName ("1.0.3", "1.0.3-preview") and the package that installed it (F-Droid's client, …). */
  getAppInfo(): Promise<{ version: string; installer?: string }>;
  /** The network-wide back-off in force, if any (until 0 = none). */
  getBlockState(): Promise<{ until: number; reason?: string }>;
  /**
   * Y6: the IPv4 setting, for extraction and streaming alike (saved natively, applied at
   * service start). A change lifts a running back-off.
   */
  setNetworkPrefs(o: { ipv4: 'auto' | 'always' | 'off' }): Promise<void>;
  /** Lift the back-off now ("Try now"); playback it stopped resumes. */
  retryNow(): Promise<void>;
  /** For the Settings diagnostics line. */
  getNetStatus(): Promise<{
    family?: string;
    ipv4?: string;
    autoIpv4?: boolean;
    lastLimit?: { at: number; reason: string; surface: string };
  }>;
  /**
   * The listening cache: the liked songs, newest like first (at most BRIDGE_MAX_ITEMS), and which
   * of them are members-only (their audio is tagged, so a sign-out removes it). Native keeps them
   * in the cache last, and saves them so they play offline (those liked since the last call
   * first), on Wi-Fi only unless setDownloadOnMobileData is on. The upkeep calls (this, setCacheLimit, clearCache, signedOut) resolve once
   * done, and reject when there is no cache.
   * Every `ytIds` here, in cachedIds and in cacheChanged holds audio ids (isAudioId): a video id,
   * or `mp3:<file>` for a Jukebox MP3 (audioIdOf). Native drops any other entry.
   */
  setLikedIds(o: { ytIds: string[]; membersOnly: string[] }): Promise<void>;
  /** The listening cache's size; 128, 256 or 512 (anything else is 256). A smaller one evicts at once. */
  setCacheLimit(o: { mb: number }): Promise<void>;
  /** Download using mobile data: liked songs are saved on any network, not only Wi-Fi. Off by default; needs no cache. */
  setDownloadOnMobileData(o: { enabled: boolean }): Promise<void>;
  /** Empties the listening cache. Playback goes on. */
  clearCache(): Promise<void>;
  /**
   * Signed out (or starting signed out): the cached audio of every members-only track goes, and
   * none is cached again until signedIn(). Cheap when there is none.
   */
  signedOut(): Promise<void>;
  /** Signed in: members-only audio may be cached again. */
  signedIn(): Promise<void>;
  /** The liked songs saved whole on the phone, by audio id: they play offline. */
  cachedIds(): Promise<{ ytIds: string[] }>;
  /** Keep a screen area (CSS px relative to the WebView) out of the system back gesture; null clears it. */
  setGestureExclusion(rect: { left: number; top: number; width: number; height: number } | null): Promise<void>;
  /** Native re-sends `tracks` when a `tracks` or `state` listener is added (K4): add `tracks` first. */
  addListener(event: 'state', cb: (s: NativeState) => void): Promise<{ remove: () => Promise<void> }>;
  /**
   * A track failed. `kind`: 'network' when the connection did (native paused on it, and picks
   * up by itself when `resumes`), 'track' when the track itself did. An older native sends
   * neither: treat it as 'track'.
   */
  addListener(
    event: 'trackError',
    cb: (e: { trackId: string; message: string; skipped: boolean; kind?: 'network' | 'track'; resumes?: boolean }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  /** YouTube is refusing this network: playback paused, nothing is requested until `until`. */
  addListener(event: 'blocked', cb: (e: BlockedEvent) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(event: 'unblocked', cb: (e: Record<string, never>) => void): Promise<{ remove: () => Promise<void> }>;
  /** Autoplay has `left` (<= 5) Jukebox tracks to go: send more with addAutoplay. */
  addListener(event: 'queueLow', cb: (e: { left: number; seedId: string | null }) => void): Promise<{ remove: () => Promise<void> }>;
  /** The Global tracks in the queue (radio items, and after a reload every Global track), so they can be shown. */
  addListener(event: 'tracks', cb: (e: { tracks: NativeTrack[] }) => void): Promise<{ remove: () => Promise<void> }>;
  /** Parsing failed in a way that means YouTube changed something (an app update is needed). */
  addListener(event: 'extractorBroken', cb: (e: { message: string }) => void): Promise<{ remove: () => Promise<void> }>;
  /** The liked songs saved whole changed (sent only when the set does, at most every 2 s): the whole set. */
  addListener(event: 'cacheChanged', cb: (e: { ytIds: string[] }) => void): Promise<{ remove: () => Promise<void> }>;
  /** The media notification was tapped (kept until a listener comes, for a cold start). */
  addListener(event: 'openNowPlaying', cb: (e: Record<string, never>) => void): Promise<{ remove: () => Promise<void> }>;
}

export const JukePlayer = registerPlugin<JukePlayerPlugin>('JukePlayer');
