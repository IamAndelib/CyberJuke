/**
 * "↑ 3 new tracks" pill at the top of Home. Shown when the freshness check found posts
 * newer than the feed; tapping it reloads the Latest list and scrolls to the top. The
 * feed never changes on its own. Self-contained: mount it as the first child of Home.
 */
import { useRef, useState } from 'preact/hooks';
import { freshness, refreshLatest } from '../../store/newTracks';
import { FRESHNESS_LIMIT } from '../../data/firestore';
import { Icon } from '../icons';

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function newTracksLabel(count: number): string {
  if (count >= FRESHNESS_LIMIT) return `${FRESHNESS_LIMIT}+ new tracks`;
  return `${count} new track${count === 1 ? '' : 's'}`;
}

export function NewTracksPill() {
  const p = freshness.pending.value;
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    ref.current?.closest('.screen')?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    try {
      await refreshLatest();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="ntp-dock" ref={ref}>
      {p && (
        <button class="ntp" onClick={go} aria-busy={busy} data-testid="new-tracks-pill" data-count={p.count}>
          <Icon name="up" size={16} />
          <span>{newTracksLabel(p.count)}</span>
        </button>
      )}
    </div>
  );
}
