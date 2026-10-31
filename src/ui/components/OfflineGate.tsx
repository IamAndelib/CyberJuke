import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { online, recheckNetwork } from '../../core/network';
import { OFFLINE } from '../../core/offlineText';
import { Icon } from '../icons';
import { goToLiked } from '../../player';
import { hasSavedLiked } from '../../stores/savedOffline';

/** Redial shows it's dialling at least this long, so a tap that changes nothing still shows. */
const REDIAL_MIN_MS = 600;

/**
 * No carrier: the one offline state, with Redial. Redial asks the OS for the connection
 * again (back online, the lists on screen reload by themselves), then runs `onRedial`. With
 * liked songs saved on the phone it also offers Liked, where they play.
 */
export function OfflineState({
  body = OFFLINE.jukebox,
  onRedial,
  alert,
  compact,
  fill,
  appear,
  testid = 'offline',
}: {
  body?: string;
  onRedial?: () => void;
  /** A request that just failed (not the device going offline, which the banner says). */
  alert?: boolean;
  compact?: boolean;
  /** Alone on its screen: in the middle of the space under the top bar. */
  fill?: boolean;
  /** Fades in. */
  appear?: boolean;
  testid?: string;
}) {
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const redial = async () => {
    if (busy) return;
    setBusy(true);
    const shown = new Promise((r) => setTimeout(r, REDIAL_MIN_MS));
    await recheckNetwork();
    onRedial?.();
    await shown;
    if (live.current) setBusy(false);
  };
  return (
    <div class={'state' + (compact ? ' compact' : '') + (fill ? ' fill' : '') + (appear ? ' appear' : '')} data-testid={testid} role={alert ? 'alert' : undefined}>
      <div class="state-glyph" aria-hidden="true">
        {OFFLINE.glyph}
      </div>
      <div class="state-title">{OFFLINE.title}</div>
      <div class="state-body">{body}</div>
      <button class="btn" onClick={redial} aria-busy={busy} data-testid="retry">
        {busy ? <span class="spinner" aria-hidden="true" /> : <Icon name="refresh" size={18} />} {OFFLINE.redial}
      </button>
      {hasSavedLiked.value && (
        <button class="btn primary" onClick={goToLiked} data-testid={`${testid}-liked`}>
          <Icon name="heart" size={18} /> {OFFLINE.likedAction}
        </button>
      )}
    </div>
  );
}

/**
 * Offline only the liked songs saved on the phone play (Liked has them), so a list that only
 * leads to music shows the offline state instead of its rows, when it opens offline. Once it has shown its rows it keeps them
 * (they dim, and a tap says to connect), so losing the connection takes nothing off the
 * screen. Opened offline, it shows its rows as soon as the connection is back (a load
 * that failed meanwhile is retried on reconnect). `fill`: the state is all the screen
 * shows, so it sits in the middle.
 */
export function OfflineGate({ children, body, fill, seen }: { children: ComponentChildren; body?: string; fill?: boolean; seen?: boolean }) {
  const own = useSeenOnline();
  return (seen ?? own) ? <>{children}</> : <OfflineState body={body} fill={fill} appear />;
}

/**
 * Whether the screen has been online since it opened: what OfflineGate goes by. A screen that
 * says something about its list outside the gate (a count in its title) asks this, and passes
 * it to the gate as `seen`, so the two always agree.
 */
export function useSeenOnline(): boolean {
  const seen = useRef(false);
  if (online.value) seen.current = true;
  return seen.current;
}
