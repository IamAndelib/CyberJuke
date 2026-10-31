import { useEffect, useRef, useState } from 'preact/hooks';
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
 * with its text already in it. With `announceBack` (the app's bar, which is always there),
 * coming back online is said too, for BACK_ONLINE_MS, to the screen reader only.
 */
export function OfflineLine({ class: cls, testid, announceBack }: { class: string; testid: string; announceBack?: boolean }) {
  const back = useBackOnline(!!announceBack);
  return (
    <div class="offline-status" role="status" data-testid={`${testid}-status`}>
      {back && <span class="sr-only">{OFFLINE.backOnline}</span>}
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

/** How long "back online" stays in the live region (long enough to be read out). */
const BACK_ONLINE_MS = 4000;

/** True for BACK_ONLINE_MS after the connection comes back (offline → online), when `on`. */
function useBackOnline(on: boolean): boolean {
  const now = online.value;
  const was = useRef(now);
  const [back, setBack] = useState(false);
  useEffect(() => {
    const came = on && now && !was.current;
    was.current = now;
    setBack(came);
    if (!came) return;
    const t = setTimeout(() => setBack(false), BACK_ONLINE_MS);
    return () => clearTimeout(t);
  }, [now, on]);
  return back;
}
