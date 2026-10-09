import type { LoadError } from '../core/errors';
import { catalog } from '../stores/catalog';
import { toast } from '../stores/toast';

/** A pull to refresh that didn't work: what was shown stays, and a message says so. */
export function sayRefreshFailed(err: LoadError | null | undefined): void {
  if (err) toast(err.offline ? "You're offline. Showing what's already loaded." : "Couldn't refresh. Try again in a moment.");
}

/** Pull to refresh on a screen built from the catalog (Genres, Artists, Most saved). */
export async function refreshCatalog(): Promise<void> {
  await catalog.refresh({ force: true });
  sayRefreshFailed(catalog.error.peek());
}
