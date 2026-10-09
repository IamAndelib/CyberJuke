/**
 * Every player command goes through `safe()`: a rejected native call (the service
 * is gone, a bad index) shows a toast instead of failing silently or surfacing as an
 * unhandled rejection. Reads (`state`, `kind`) pass straight through.
 */
import { safe, type Notify } from '../core/safe';
import type { Player } from './types';

type Command = Exclude<keyof Player, 'kind' | 'state' | 'onQueueLow'>;

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
  removeIds: "Couldn't remove those tracks",
  addToQueue: "Couldn't add to the queue",
  restore: "Couldn't put that track back",
  addAutoplay: "Couldn't add autoplay tracks",
  setAutoplay: "Couldn't change autoplay",
  setQuality: "Couldn't change the audio quality",
  setNetworkPrefs: "Couldn't change the network setting",
};

/** Background work the user didn't ask for: a failure is logged, not toasted. */
const SILENT: ReadonlySet<Command> = new Set<Command>(['addAutoplay', 'setAutoplay', 'removeIds']);
const quiet: Notify = () => {};

export function safePlayer(p: Player, notify: Notify): Player {
  const wrap =
    <K extends Command>(name: K) =>
    (...args: Parameters<Player[K]>): Promise<void> =>
      safe(`player.${name}`, () => (p[name] as (...a: Parameters<Player[K]>) => Promise<void>)(...args), SILENT.has(name) ? quiet : notify, COMMAND_ERRORS[name]).then(
        () => {},
      );
  return {
    kind: p.kind,
    state: p.state,
    onQueueLow: (cb) => p.onQueueLow(cb),
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
    removeIds: wrap('removeIds'),
    addToQueue: wrap('addToQueue'),
    restore: wrap('restore'),
    addAutoplay: wrap('addAutoplay'),
    setAutoplay: wrap('setAutoplay'),
    setQuality: wrap('setQuality'),
    setNetworkPrefs: wrap('setNetworkPrefs'),
  };
}
