/**
 * Offline nothing can play, so a command that would start or resume playback is refused
 * up front: `allowed()` says so (and shows why), and neither native nor the web player
 * hears of it, so the player's state stays as it was. Pausing, seeking, queue edits and
 * settings still go through.
 */
import type { Player } from './types';

export function offlineGuard(p: Player, allowed: () => boolean): Player {
  const done = Promise.resolve();
  return {
    ...p,
    playList: (...a) => (allowed() ? p.playList(...a) : done),
    play: () => (allowed() ? p.play() : done),
    // Only a resume is refused: a pause always works.
    toggle: () => (p.state.peek().isPlaying || allowed() ? p.toggle() : done),
    next: () => (allowed() ? p.next() : done),
    prev: () => (allowed() ? p.prev() : done),
    skipTo: (...a) => (allowed() ? p.skipTo(...a) : done),
  };
}
