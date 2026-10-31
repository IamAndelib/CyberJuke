/**
 * Every offline line the app shows, in one voice (the terminal style of `[ NO CARRIER ]`
 * and "Feeling lucky?"), so they stay consistent. Offline the only music that plays is liked
 * songs saved on the phone, so they say that when some are, and
 * "connect" otherwise. Here in core because the player's toasts use them as well as the
 * screens.
 */
export const OFFLINE = {
  /** The bar at the top while the device is offline (wrapped, the · stays on the first line). */
  banner: '[ offline ] no carrier\u00a0· connect to play',
  /** The bar while offline with liked songs saved (it opens Liked). */
  bannerLiked: '[ offline ] no carrier\u00a0· your liked songs still play',
  /** The state a list shows instead of its rows (OfflineGate). */
  glyph: '[ NO CARRIER ]',
  title: "Line's dead",
  jukebox: 'Connect to the internet to load the Jukebox.',
  global: 'Connect to the internet to search Global.',
  redial: 'Redial',
  /** A tap that would play something. */
  tap: 'No carrier. Connect to play.',
  /** The same with liked songs saved: its button opens Liked. */
  tapLiked: 'No carrier. Your liked songs still play.',
  likedAction: 'Liked',
  /** A liked song not saved on the phone yet, tapped offline. */
  notSaved: 'Not saved yet. Needs a connection.',
  /** The connection dropped mid-track and the player won't pick up by itself. */
  lostWaits: "Signal lost. Press play once you're back online.",
  /** In place of the time (Now Playing) and the artist (mini player) while native waits for the network. */
  waiting: 'Waiting for carrier…',
  /** The end of a list with more to come, while offline (it loads by itself once back). */
  moreLater: "No carrier. More loads when you're back.",
  /** Said to a screen reader for a moment once the connection is back (the bar's live region). */
  backOnline: 'CONNECT. Back online.',
  /** Home's Shuffle while offline with liked songs saved: they play. */
  heroKicker: 'No carrier',
  heroLiked: 'Shuffle liked songs',
  heroLikedSub: 'Saved on the phone · plays offline',
  /** A pull to refresh while offline. */
  pullAgain: 'No carrier. Connect, then refresh.',
  lyrics: "No carrier. Lyrics load when you're back online.",
} as const;

/** Offline, a song that couldn't load was passed over for the next saved one. */
export const skippedOffline = (title: string): string => `No carrier. Skipped "${title}": not saved on the phone.`;

/** Offline, a page of Global's (an album, a playlist, a list) that can't load: what it would load. */
export const loadThis = (what: string): string => `Connect to the internet to load this ${what}.`;

/** The connection dropped mid-track; the player picks up by itself once it's back. */
export const signalLost = (title: string): string => `Signal lost. "${title}" picks up when you're back.`;
