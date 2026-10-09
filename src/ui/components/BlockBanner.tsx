/**
 * Y1 banners, above the mini player, never in the way of the rest of the app:
 * - YouTube is limiting this network: when CyberJuke tries again by itself (a countdown in
 *   whole minutes, updated as the minute changes) and "Try now"; dismissable until the next block.
 * - YouTube changed something: only an app update helps; links to the releases.
 */
import { useEffect, useState } from 'preact/hooks';
import { player } from '../../player';
import { RELEASES_URL } from '../../data/model';
import { block, blockedText, BROKEN_TEXT, msToNextMinute } from '../../stores/block';
import { Icon } from '../icons';
import { openExternal } from '../links';

function Blocked({ until }: { until: number }) {
  const now = Date.now();
  // Re-renders when the minute shown changes (one timer a minute, no frame loop).
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setTick((n) => n + 1), msToNextMinute(until, Date.now()) + 20);
    return () => clearTimeout(t);
  });
  return (
    <div class="block-banner" role="status" data-testid="block-banner" data-tap-through>
      <p class="block-text" data-testid="block-text">
        {blockedText(until, now)}
      </p>
      <button
        class="block-action"
        onClick={() => {
          // Native lifts the back-off at once and says so with `unblocked` (which hides this),
          // then resumes playback it stopped; if YouTube still refuses, a new `blocked` event
          // brings the banner back. If the call fails, the banner stays.
          void player.retryNow();
        }}
        data-testid="block-retry"
      >
        [Try now]
      </button>
      <button class="icon-btn sm block-close" aria-label="Dismiss" onClick={() => block.dismiss()} data-testid="block-dismiss">
        <Icon name="close" size={20} />
      </button>
    </div>
  );
}

function Broken() {
  return (
    <div class="block-banner" role="status" data-testid="broken-banner" data-tap-through>
      <p class="block-text">
        {BROKEN_TEXT}{' '}
        <a
          href={RELEASES_URL}
          onClick={(e) => {
            e.preventDefault();
            openExternal(RELEASES_URL);
          }}
          data-testid="broken-releases"
        >
          Releases
        </a>
      </p>
      <button class="icon-btn sm block-close" aria-label="Dismiss" onClick={() => block.dismissBroken()} data-testid="broken-dismiss">
        <Icon name="close" size={20} />
      </button>
    </div>
  );
}

export function BlockBanner() {
  const b = block.banner.value;
  const broken = block.brokenBanner.value;
  if (!b && !broken) return null;
  return (
    <div class="block-dock">
      {broken && <Broken />}
      {b && <Blocked until={b.until} />}
    </div>
  );
}
