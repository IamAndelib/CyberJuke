/**
 * What a player's `trackError` says. Native's event (nativePlayer) and the web player's test
 * hook share it, so the e2e journeys see the words the phone shows.
 */
import { OFFLINE, signalLost, skippedOffline } from '../core/offlineText';

/** A `trackError` event's fields that pick the text (the rest names the track). */
export interface TrackErrorFacts {
  /** The track was skipped (unavailable; with 'network', passed over offline for a saved one). */
  skipped?: boolean;
  /** 'network': a lost connection, no fault of the track. An older native sends no kind. */
  kind?: string;
  /** Native picks up by itself once the connection is back. */
  resumes?: boolean;
}

/**
 * A lost connection is no fault of the track (native picks up by itself when `resumes`). An
 * older native sends no `kind`: about the track, as before.
 */
export function trackErrorText(e: TrackErrorFacts | null | undefined, title: string): string {
  if (e?.skipped) return e.kind === 'network' ? skippedOffline(title) : `Skipped "${title}": unavailable`;
  if (e?.kind === 'network') return e.resumes ? signalLost(title) : OFFLINE.lostWaits;
  return `Can't play "${title}"`;
}
