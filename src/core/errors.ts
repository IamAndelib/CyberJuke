/**
 * The error model. A failure that reaches a screen is a LoadError: the error's own
 * message, whether the connection was lost, and the code some sources attach
 * (MusicError's BOT_CHECK, NETWORK, UNAVAILABLE). The sources' error classes carry
 * these (FirestoreError `offline`, AuthError both, MusicError `code` only); what
 * each source's failures say to the user stays with that source (authErrorText,
 * musicErrorText).
 */

export interface LoadError {
  message: string;
  offline: boolean;
  code?: string;
}

/** An Error's message; anything else as text, or `fallback` when given. */
export function errorMessage(e: unknown, fallback?: string): string {
  return e instanceof Error ? e.message : (fallback ?? String(e));
}

/** The error says the connection was lost (its `offline` flag). */
export function isOffline(e: unknown): boolean {
  return !!(e as { offline?: boolean } | null)?.offline;
}

/** A failure as a screen shows it. `offlineNow`: the device has no network, so it counts as offline too. */
export function toLoadError(e: unknown, offlineNow = false): LoadError {
  const code = (e as { code?: unknown } | null)?.code;
  return {
    message: errorMessage(e),
    offline: isOffline(e) || offlineNow,
    ...(typeof code === 'string' && { code }),
  };
}

/**
 * For logs and the boot error screen: the error's name and message only, never
 * search queries, track ids or tokens.
 */
export function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  return String(e);
}
