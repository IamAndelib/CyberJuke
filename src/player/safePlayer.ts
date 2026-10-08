/**
 * Every player command goes through `safe()`: a rejected native call (the service
 * is gone, a bad index) shows a toast instead of failing silently or surfacing as an
 * unhandled rejection. Reads (`state`, `kind`) pass straight through.
 */
import { safe, type Notify } from '../core/safe';
import type { Player } from './types';

type Command = Exclude<keyof Player, 'kind' | 'state'>;

/** What the toast says when a command fails. */
export const COMMAND_ERRORS: Record<Command, string> = {
  playList: "Couldn't start playback",
  play: "Couldn't play",
  pause: "Couldn't pause",
  toggle: "Couldn't play or pause",
  next: "Couldn't skip to the next track",
  prev: "Couldn't go back",
  seek: "Couldn't seek",
  skipTo: "Couldn't play that track",
  setShuffle: "Couldn't change shuffle",
  setRepeat: "Couldn't change repeat",
  move: "Couldn't move that track",
  remove: "Couldn't remove that track",
  addToQueue: "Couldn't add to the queue",
  setQuality: "Couldn't change the audio quality",
  setNetworkPrefs: "Couldn't change the network setting",
};

export function safePlayer(p: Player, notify: Notify): Player {
  const wrap =
    <K extends Command>(name: K) =>
    (...args: Parameters<Player[K]>): Promise<void> =>
      safe(`player.${name}`, () => (p[name] as (...a: Parameters<Player[K]>) => Promise<void>)(...args), notify, COMMAND_ERRORS[name]).then(() => {});
  return {
    kind: p.kind,
    state: p.state,
    playList: wrap('playList'),
    play: wrap('play'),
    pause: wrap('pause'),
    toggle: wrap('toggle'),
    next: wrap('next'),
    prev: wrap('prev'),
    seek: wrap('seek'),
    skipTo: wrap('skipTo'),
    setShuffle: wrap('setShuffle'),
    setRepeat: wrap('setRepeat'),
    move: wrap('move'),
    remove: wrap('remove'),
    addToQueue: wrap('addToQueue'),
    setQuality: wrap('setQuality'),
    setNetworkPrefs: wrap('setNetworkPrefs'),
  };
}
