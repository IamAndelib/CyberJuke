/**
 * Every offline line the app shows, in one voice (the terminal style of `[ NO CARRIER ]`
 * and "Feeling lucky?"), so they stay consistent. Offline nothing plays, so they all say
 * the same thing: connect. Here in core because the player's toasts use them as well as
 * the screens.
 */
export const OFFLINE = {
  /** The bar at the top while the device is offline. */
  banner: '[ offline ] no carrier · connect to play',
  /** The state a list shows instead of its rows (OfflineGate). */
  glyph: '[ NO CARRIER ]',
  title: "Line's dead",
  jukebox: 'Connect to the internet to load the Jukebox.',
  global: 'Connect to the internet to search Global.',
  redial: 'Redial',
  /** A tap that would play something. */
  tap: 'No carrier. Connect to play.',
  /** The connection dropped mid-track and the player won't pick up by itself. */
  lostWaits: "Signal lost. Press play once you're back online.",
  pullAgain: 'No carrier. Connect and pull again.',
  lyrics: "No carrier. Lyrics load when you're back online.",
} as const;

/** The connection dropped mid-track; the player picks up by itself once it's back. */
export const signalLost = (title: string): string => `Signal lost. "${title}" picks up when you're back.`;
