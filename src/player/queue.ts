/**
 * Pure, synchronous play-queue model used by the WebPlayer (the native side owns
 * its own queue). No I/O, no timers: every method mutates the model and returns
 * what the caller should do next.
 *
 * Terms (mirroring the native plugin contract):
 *  - "list": the queue in list order (what setQueue/addItems/moveItem index into);
 *  - "play order": the order tracks will actually play (differs when shuffled).
 *
 * The rules (shared with the native queue; the cases both must pass are in
 * tests/spec/queue-rules.json):
 *  - queued tracks play right after the current track, first in first out, shuffle
 *    or not, until each one plays or is removed;
 *  - a manual jump (skipTo, or prev moving back) to a track that isn't one of them
 *    keeps them next: they move to just after the new current track, in the order
 *    they were going to play. Jumping to one of them plays it; the others stay next;
 *  - a new list (setList) replaces the list and the autoplay tracks, but the queued
 *    tracks stay next, in order (P1);
 *  - autoplay tracks (addAuto) play after the list, in the order added. Shuffle
 *    reorders only the list. Repeat all or one drops the autoplay tracks still to
 *    come, and so does jumping to an autoplay track (the radio continues from it).
 *
 * Up next is three sections, in play order: queued by you, the rest of the list,
 * autoplay (see sections()).
 */

export type RepeatMode = 'off' | 'all' | 'one';

export interface Identified {
  id: string;
}

interface Entry<T> {
  key: number;
  item: T;
  /** Added by autoplay (addAuto). */
  auto?: boolean;
}

/** Up next split into its three sections, each in play order, with list indices. */
export interface QueueSections<T> {
  queued: { item: T; index: number }[];
  list: { item: T; index: number }[];
  autoplay: { item: T; index: number }[];
}

export const RESTART_THRESHOLD_MS = 3000;

export type PrevResult = 'restart' | 'moved';

export class Queue<T extends Identified> {
  private list: Entry<T>[] = [];
  private order: Entry<T>[] = [];
  private cur: Entry<T> | null = null;
  /** Entries added with queueNext() that haven't become current yet. */
  private queued = new Set<Entry<T>>();
  private nextKey = 1;
  shuffle = false;
  repeat: RepeatMode = 'off';

  constructor(private readonly rand: () => number = Math.random) {}

  // ---- reads ---------------------------------------------------------------------

  get items(): T[] {
    return this.list.map((e) => e.item);
  }

  get length(): number {
    return this.list.length;
  }

  /** Index of the current track in list order, -1 if none. */
  get index(): number {
    return this.cur ? this.list.indexOf(this.cur) : -1;
  }

  get current(): T | null {
    return this.cur?.item ?? null;
  }

  /** The next tracks in actual play order (respects shuffle), at most `max`. */
  upNext(max = 50): T[] {
    if (!this.cur) return this.order.slice(0, max).map((e) => e.item);
    const p = this.order.indexOf(this.cur);
    return this.order.slice(p + 1, p + 1 + max).map((e) => e.item);
  }

  /** List indices of upNext(), so a UI can address items in list order. */
  upNextIndices(max = 50): number[] {
    const p = this.cur ? this.order.indexOf(this.cur) : -1;
    return this.order.slice(p + 1, p + 1 + max).map((e) => this.list.indexOf(e));
  }

  /** How many of the first upNext() items were queued by the user ("Queued by you"). */
  get queuedCount(): number {
    const p = this.cur ? this.order.indexOf(this.cur) : -1;
    let n = 0;
    while (p + 1 + n < this.order.length && this.queued.has(this.order[p + 1 + n])) n++;
    return n;
  }

  /** Whether the item at a list index was added by autoplay. */
  isAuto(index: number): boolean {
    return this.list[index]?.auto === true;
  }

  /** The current track was added by autoplay. */
  get currentIsAuto(): boolean {
    return this.cur?.auto === true;
  }

  /** Autoplay tracks still to come (after the current one in play order). */
  get autoAhead(): number {
    const p = this.cur ? this.order.indexOf(this.cur) : -1;
    let n = 0;
    for (let k = p + 1; k < this.order.length; k++) if (this.order[k].auto) n++;
    return n;
  }

  /**
   * Up next (at most `max` tracks) as its three sections: the leading run of queued
   * tracks, then the list, then autoplay.
   */
  sections(max = 50): QueueSections<T> {
    const out: QueueSections<T> = { queued: [], list: [], autoplay: [] };
    const p = this.cur ? this.order.indexOf(this.cur) : -1;
    let leading = true;
    for (const e of this.order.slice(p + 1, p + 1 + max)) {
      const it = { item: e.item, index: this.list.indexOf(e) };
      if (leading && this.queued.has(e)) {
        out.queued.push(it);
        continue;
      }
      leading = false;
      (e.auto ? out.autoplay : out.list).push(it);
    }
    return out;
  }

  // ---- loading -------------------------------------------------------------------

  /**
   * Replace the list (and any autoplay tracks) with `items` and make `startIndex`
   * current. Tracks still queued with queueNext stay next, in play order (P1).
   * An empty list clears everything.
   */
  setList(items: T[], startIndex = 0): T | null {
    if (!items.length) {
      this.clear();
      return null;
    }
    const kept = this.order.filter((e) => e !== this.cur && this.queued.has(e));
    this.queued = new Set(kept);
    this.list = items.map((item) => this.entry(item));
    const i = clamp(startIndex, 0, this.list.length - 1);
    this.cur = this.list[i];
    this.list.splice(i + 1, 0, ...kept);
    this.rebuildOrder();
    return this.cur.item;
  }

  // ---- navigation ----------------------------------------------------------------

  /**
   * Advance. `auto` is true when the current track ended by itself (repeat-one then
   * replays it); a user "next" always moves on. Returns the new current track, or
   * null when playback should stop (end of queue with repeat off).
   */
  next(auto = false): T | null {
    if (!this.cur) return null;
    if (auto && this.repeat === 'one') return this.cur.item;
    const p = this.order.indexOf(this.cur);
    if (p + 1 < this.order.length) {
      this.cur = this.order[p + 1];
      this.settle();
      return this.cur.item;
    }
    if (this.repeat === 'all' || (this.repeat === 'one' && !auto)) {
      this.cur = this.order[0];
      this.settle();
      return this.cur.item;
    }
    return null;
  }

  /**
   * Go back. If more than 3 s into the track (or there is nothing before it),
   * the caller should restart the current track.
   */
  prev(positionMs: number): PrevResult {
    if (!this.cur) return 'restart';
    if (positionMs > RESTART_THRESHOLD_MS) return 'restart';
    const p = this.order.indexOf(this.cur);
    if (p > 0) {
      this.cur = this.order[p - 1];
      this.settle();
      this.keepQueuedNext();
      return 'moved';
    }
    if (this.repeat === 'all' && this.order.length > 1) {
      this.cur = this.order[this.order.length - 1];
      this.settle();
      this.keepQueuedNext();
      return 'moved';
    }
    return 'restart';
  }

  /**
   * Jump to a list index. Tracks still queued stay next (see the rule above). Jumping
   * to an autoplay track drops the autoplay tracks after it: the radio continues
   * from the new track.
   */
  skipTo(index: number): T | null {
    const e = this.list[index];
    if (!e) return null;
    this.cur = e;
    this.settle();
    this.keepQueuedNext();
    if (e.auto) this.dropAuto();
    return e.item;
  }

  // ---- modes ---------------------------------------------------------------------

  setShuffle(on: boolean): void {
    this.shuffle = on;
    this.rebuildOrder();
  }

  /** Repeat all or one turns autoplay off: the autoplay tracks still to come go. */
  setRepeat(mode: RepeatMode): void {
    this.repeat = mode;
    if (mode !== 'off') this.dropAuto();
  }

  // ---- editing -------------------------------------------------------------------

  /** Move an item in list order. Play order follows list order unless shuffled. */
  move(from: number, to: number): void {
    if (!inRange(from, this.list) || !inRange(to, this.list) || from === to) return;
    const [e] = this.list.splice(from, 1);
    this.list.splice(to, 0, e);
    if (!this.shuffle) this.order = this.list.slice();
  }

  /**
   * Remove the item at a list index. If it was current, the next track in play
   * order (or the previous one, at the end) becomes current. Returns true when the
   * current track changed.
   */
  remove(index: number): boolean {
    if (!inRange(index, this.list)) return false;
    const e = this.list[index];
    let changed = false;
    if (e === this.cur) {
      const p = this.order.indexOf(e);
      this.cur = this.order[p + 1] ?? this.order[p - 1] ?? null;
      this.settle();
      changed = true;
    }
    this.queued.delete(e);
    this.list.splice(index, 1);
    this.order.splice(this.order.indexOf(e), 1);
    return changed;
  }

  /**
   * "Add to queue": play these next, after the current track and after anything queued
   * earlier (first in, first out), in list and play order, shuffle or not. With nothing
   * playing, the first one becomes current.
   */
  queueNext(items: T[]): void {
    if (!items.length) return;
    const entries = items.map((i) => this.entry(i));
    if (!this.cur) {
      this.list.unshift(...entries);
      this.order.unshift(...entries);
      this.cur = entries[0];
      for (const e of entries.slice(1)) this.queued.add(e);
      return;
    }
    const at = (arr: Entry<T>[]) => {
      let k = arr.indexOf(this.cur!) + 1;
      while (k < arr.length && this.queued.has(arr[k])) k++;
      return k;
    };
    this.list.splice(at(this.list), 0, ...entries);
    this.order.splice(at(this.order), 0, ...entries);
    for (const e of entries) this.queued.add(e);
  }

  /**
   * Autoplay: append tracks after everything else, in list and play order (shuffle
   * never moves them). With nothing playing, the first one becomes current.
   */
  addAuto(items: T[]): void {
    if (!items.length) return;
    const entries = items.map((i) => ({ ...this.entry(i), auto: true }));
    this.list.push(...entries);
    this.order.push(...entries);
    if (!this.cur) this.cur = entries[0];
  }

  /** Remove the autoplay tracks still to come. Returns how many went. */
  dropAuto(): number {
    const p = this.cur ? this.order.indexOf(this.cur) : -1;
    const gone = new Set(this.order.slice(p + 1).filter((e) => e.auto));
    if (!gone.size) return 0;
    this.list = this.list.filter((e) => !gone.has(e));
    this.order = this.order.filter((e) => !gone.has(e));
    return gone.size;
  }

  /** Append tracks to the end of the queue (in list and play order). */
  add(items: T[]): void {
    if (!items.length) return;
    const entries = items.map((i) => this.entry(i));
    this.list.push(...entries);
    this.order.push(...entries);
    if (!this.cur) this.cur = entries[0];
  }

  clear(): void {
    this.queued.clear();
    this.list = [];
    this.order = [];
    this.cur = null;
  }

  // ---- internals -----------------------------------------------------------------

  /** The current entry changed: a queued track that starts playing is no longer "queued". */
  private settle(): void {
    if (this.cur) this.queued.delete(this.cur);
  }

  /** Move the still-queued tracks to just after the current one, keeping their play order. */
  private keepQueuedNext(): void {
    const cur = this.cur;
    if (!cur || !this.queued.size) return;
    const pending = this.order.filter((e) => this.queued.has(e));
    const isPending = (e: Entry<T>) => this.queued.has(e);
    this.list = this.list.filter((e) => !isPending(e));
    this.order = this.order.filter((e) => !isPending(e));
    this.list.splice(this.list.indexOf(cur) + 1, 0, ...pending);
    this.order.splice(this.order.indexOf(cur) + 1, 0, ...pending);
  }

  private entry(item: T): Entry<T> {
    return { key: this.nextKey++, item };
  }

  private rebuildOrder(): void {
    if (!this.shuffle) {
      this.order = this.list.slice();
      return;
    }
    // Queued tracks keep playing next, in the order they were added; autoplay tracks
    // stay last, in their order. Only the list is shuffled.
    const cur = this.cur;
    const queued = this.list.filter((e) => e !== cur && this.queued.has(e));
    const autos = this.list.filter((e) => e.auto && !this.queued.has(e));
    const rest = this.list.filter((e) => e !== cur && !e.auto && !this.queued.has(e));
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    if (!cur) this.order = [...queued, ...rest, ...autos];
    else if (!cur.auto) this.order = [cur, ...queued, ...rest, ...autos];
    else {
      // Playing autoplay: the list is behind; what's ahead keeps its order.
      const k = autos.indexOf(cur);
      this.order = [...rest, ...autos.slice(0, k + 1), ...queued, ...autos.slice(k + 1)];
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function inRange(i: number, a: unknown[]): boolean {
  return Number.isInteger(i) && i >= 0 && i < a.length;
}
