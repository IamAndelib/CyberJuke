/**
 * Y1 banners, above the mini player, never in the way of the rest of the app:
 * - YouTube is limiting this network: when to try again (a live countdown in whole
 *   minutes) and what helps; dismissable until the next block.
 * - YouTube changed something: only an app update helps; links to the releases.
 */
import { block, blockedText, BROKEN_TEXT, minutesLeft, RELEASES_URL } from '../../stores/block';
import { Icon } from '../icons';
import { openExternal } from '../links';
import { useTickValue } from '../useTick';

function Blocked({ until }: { until: number }) {
  // Re-renders when the minute shown changes.
  const now = Date.now();
  useTickValue(true, () => minutesLeft(until, Date.now()));
  return (
    <div class="block-banner" role="status" data-testid="block-banner">
      <p class="block-text" data-testid="block-text">
        {blockedText(until, now)}
      </p>
      <button class="icon-btn sm block-close" aria-label="Dismiss" onClick={() => block.dismiss()} data-testid="block-dismiss">
        <Icon name="close" size={20} />
      </button>
    </div>
  );
}

function Broken() {
  return (
    <div class="block-banner" role="status" data-testid="broken-banner">
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
