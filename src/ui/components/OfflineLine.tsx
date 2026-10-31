import { goToLiked } from '../../player';
import { online } from '../../core/network';
import { OFFLINE } from '../../core/offlineText';
import { hasSavedLiked } from '../../stores/savedOffline';

/**
 * The line that says the device is offline: the bar at the top of the app, and the same bar at
 * the top of Now Playing (the sheet covers the app's). With liked songs saved on the phone it says they still
 * play, and a tap opens Liked; otherwise it asks to connect. It never says how many. One
 * component, so both places always agree; `class` places it (see .offline-line in ui/ui.css).
 * `testid` names the line, its Liked button `<testid>-liked` and its live region `<testid>-status`.
 *
 * The live region (role="status") is always there, empty while online: a screen reader
 * announces text that comes into a region it already knows, not always one that appears
 * with its text already in it.
 */
export function OfflineLine({ class: cls, testid }: { class: string; testid: string }) {
  return (
    <div class="offline-status" role="status" data-testid={`${testid}-status`}>
      {!online.value && (
        <div class={`offline-line ${cls}`} data-testid={testid}>
          {hasSavedLiked.value ? (
            <button type="button" class="offline-link" onClick={goToLiked} data-testid={`${testid}-liked`}>
              {OFFLINE.bannerLiked}
            </button>
          ) : (
            OFFLINE.banner
          )}
        </div>
      )}
    </div>
  );
}
