import { useEffect, useRef, useState } from 'preact/hooks';
import { goToLibrary } from '../../player';
import { online } from '../../core/network';
import { OFFLINE } from '../../core/offlineText';
import { offlinePlays } from '../../stores/local';

/**
 * The line that says the device is offline: the bar at the top of the app, and the same bar at
 * the top of Now Playing (the sheet covers the app's). With liked songs saved on the phone or
 * local songs it says which still play, and a tap opens Library; otherwise it asks to connect.
 * It never says how many. One component, so both places always agree; `class` places it (see
 * .offline-line in ui/ui.css). `testid` names the line, its Library button `<testid>-library`
 * and its live region `<testid>-status`.
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
          {offlinePlays.value ? (
            <button type="button" class="offline-link" onClick={goToLibrary} data-testid={`${testid}-library`}>
              {OFFLINE.bannerPlays(offlinePlays.value)}
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
