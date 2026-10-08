/**
 * "↑ 3 new tracks" pill at the top of Home. Shown when the freshness check found posts
 * newer than the feed; tapping it scrolls to the top, and once the scroll has ended
 * (`scrollend`, or a timeout where that never comes) reloads the Latest list and fades
 * out. The list never changes under a moving scroll, and the feed never changes on its
 * own. Self-contained: mount it as the first child of Home.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { freshness, refreshLatest } from '../../store/newTracks';
import { FRESHNESS_LIMIT } from '../../data/firestore';
import { SMOOTH_SCROLL_MS, scrollAnimating } from '../clickGuard';
import { Icon } from '../icons';
import { reducedMotion } from '../motion';

/** The fade-out; the pill unmounts after it (or after this long without a transitionend). */
export const PILL_FADE_MS = 200;

export function newTracksLabel(count: number): string {
  if (count >= FRESHNESS_LIMIT) return `${FRESHNESS_LIMIT}+ new tracks`;
  return `${count} new track${count === 1 ? '' : 's'}`;
}

/** Resolve once `el` has stopped scrolling: at its `scrollend`, or after `ms`. Immediately if it isn't moving. */
function scrollEnded(el: Element, moving: boolean, ms: number): Promise<void> {
  if (!moving) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      el.removeEventListener('scrollend', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    el.addEventListener('scrollend', done, { passive: true });
  });
}

export function NewTracksPill() {
  const p = freshness.pending.value;
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  /** The count still shown while the pill fades out (the store has already cleared it). */
  const [leaving, setLeaving] = useState<number | null>(null);
  const go = async () => {
    if (busy || !p) return;
    setBusy(true);
    const screen = ref.current?.closest('.screen');
    try {
      if (screen) {
        const moving = screen.scrollTop > 0 && !reducedMotion();
        screen.scrollTo({ top: 0, behavior: moving ? 'smooth' : 'auto' });
        // A tap on the list while it glides up only stops it (clickGuard).
        const done = scrollAnimating(screen);
        await scrollEnded(screen, moving, SMOOTH_SCROLL_MS * 2);
        done();
      }
      setLeaving(p.count);
      await refreshLatest();
    } finally {
      setBusy(false);
    }
  };
  // Unmount once faded.
  useEffect(() => {
    if (leaving == null) return;
    const id = setTimeout(() => setLeaving(null), reducedMotion() ? 0 : PILL_FADE_MS);
    return () => clearTimeout(id);
  }, [leaving]);
  const count = p?.count ?? leaving;
  return (
    <div class="ntp-dock" ref={ref}>
      {count != null && (
        <button
          class={'ntp' + (leaving != null && !p ? ' out' : '')}
          onClick={go}
          aria-busy={busy}
          data-testid="new-tracks-pill"
          data-count={count}
          tabIndex={leaving != null && !p ? -1 : undefined}
        >
          <Icon name="up" size={16} />
          <span>{newTracksLabel(count)}</span>
        </button>
      )}
    </div>
  );
}
