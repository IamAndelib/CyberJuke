import { goToLiked } from '../../player';
import { OFFLINE } from '../../core/offlineText';
import { hasSavedLiked } from '../../stores/savedOffline';

/**
 * The line that says the device is offline: the bar at the top of the app, and Now Playing's
 * header (the sheet covers the bar). With liked songs saved on the phone it says they still
 * play, and a tap opens Liked; otherwise it asks to connect. It never says how many. One
 * component, so both places always agree; `class` places it (see .offline-line in ui/ui.css).
 * `testid` names the line, and its Liked button `<testid>-liked`.
 */
export function OfflineLine({ class: cls, testid }: { class: string; testid: string }) {
  return (
    <div class={`offline-line ${cls}`} role="status" data-testid={testid}>
      {hasSavedLiked.value ? (
        <button type="button" class="offline-link" onClick={goToLiked} data-testid={`${testid}-liked`}>
          {OFFLINE.bannerLiked}
        </button>
      ) : (
        OFFLINE.banner
      )}
    </div>
  );
}
