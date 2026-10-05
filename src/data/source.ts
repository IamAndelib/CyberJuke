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
 * Everything in the UI reads tracks through this interface, so the Firestore
 * implementation can be swapped for the official API by changing one file.
 */
export interface TrackSource {
  latest(cursor?: Cursor | null): Promise<Page>;
  byGenre(genre: string, cursor?: Cursor | null): Promise<Page>;
  shuffle(n: number): Promise<Track[]>;
  /** Optional: drop cached results so a pull-to-refresh fetches fresh data. */
  invalidate?(): void;
}
