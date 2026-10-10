import type { Track } from './model';

/**
 * Opaque pagination cursor. For Firestore it is the last document's
 * createdAt timestamp and full document name; other sources may use their own.
 */
export interface Cursor {
  createdAt: string;
  name: string;
}

export interface Page {
  tracks: Track[];
  cursor: Cursor | null;
}

/**
 * Everything in the app reads tracks through this interface (no `instanceof`), so the
 * Firestore implementation can be swapped for the official API in data/index.ts.
 */
export interface TrackSource {
  latest(cursor?: Cursor | null): Promise<Page>;
  byGenre(genre: string, cursor?: Cursor | null): Promise<Page>;
  shuffle(n: number): Promise<Track[]>;
  /**
   * The whole catalog, newest first, NSFW included (callers filter). With `since`,
   * only tracks posted after that instant (for incremental refreshes).
   */
  catalog(since?: Date): Promise<Track[]>;
  /** Optional: drop cached results so a pull-to-refresh fetches fresh data. */
  invalidate?(): void;

  // Optional, for a source that can do them (FirestoreSource does); without them the app
  // simply has no new-tracks check and reads signed-in genre pages from the source.
  /** Drop everything cached, including what a refresh keeps (a sign-in or sign-out). */
  invalidateAll?(): void;
  /** How many posts are newer than `since`, and the newest one's time (the new-tracks check). */
  newerThan?(since: string, opts?: { includeNsfw?: boolean }): Promise<{ count: number; newest: string | null }>;
  /** Told the newest post's time whenever the first Latest page loads. */
  onLatest?: ((newest: string) => void) | undefined;
  /** Signed in: a genre's tracks from the catalog (the members query has no genre filter). */
  genreTracks?: ((genre: string) => Promise<Track[]>) | undefined;
}
