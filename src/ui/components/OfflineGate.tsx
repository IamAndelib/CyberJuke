import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { online, recheckNetwork } from '../../core/network';
import { OFFLINE } from '../../core/offlineText';
import { Icon } from '../icons';

/** Redial shows it's dialling at least this long, so a tap that changes nothing still shows. */
const REDIAL_MIN_MS = 600;

/**
 * No carrier: the one offline state, with Redial. Redial asks the OS for the connection
 * again (back online, the lists on screen reload by themselves), then runs `onRedial`.
 */
export function OfflineState({
  body = OFFLINE.jukebox,
  onRedial,
  alert,
  compact,
  testid = 'offline',
}: {
  body?: string;
  onRedial?: () => void;
  /** A request that just failed (not the device going offline, which the banner says). */
  alert?: boolean;
  compact?: boolean;
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
    <div class={'state' + (compact ? ' compact' : '')} data-testid={testid} role={alert ? 'alert' : undefined}>
      <div class="state-glyph" aria-hidden="true">
        {OFFLINE.glyph}
      </div>
      <div class="state-title">{OFFLINE.title}</div>
      <div class="state-body">{body}</div>
      <button class="btn" onClick={redial} aria-busy={busy} data-testid="retry">
        {busy ? <span class="spinner" aria-hidden="true" /> : <Icon name="refresh" size={18} />} {OFFLINE.redial}
      </button>
    </div>
  );
}

/**
 * Offline nothing plays, so a list that only leads to music shows the offline state
 * instead of its rows. Back online it shows them again by itself (from memory when
 * they were loaded; a load that failed meanwhile is retried on reconnect).
 */
export function OfflineGate({ children, body }: { children: ComponentChildren; body?: string }) {
  return online.value ? <>{children}</> : <OfflineState body={body} />;
}
