/**
 * Every offline line the app shows, in one voice (the terminal style of `[ NO CARRIER ]`
 * and "Feeling lucky?"), so they stay consistent. Offline the only music that plays is liked
 * songs saved on the phone (the listening cache), so they say that when some are, and
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
  /** A pull to refresh while offline. */
  pullAgain: 'No carrier. Connect, then refresh.',
  lyrics: "No carrier. Lyrics load when you're back online.",
} as const;

/** The connection dropped mid-track; the player picks up by itself once it's back. */
export const signalLost = (title: string): string => `Signal lost. "${title}" picks up when you're back.`;
