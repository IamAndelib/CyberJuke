/**
 * Pure, synchronous play-queue model used by the WebPlayer (the native side owns
 * its own queue). No I/O, no timers: every method mutates the model and returns
 * what the caller should do next.
 *
 * Terms (mirroring the native plugin contract):
 *  - "list": the queue in list order (what setQueue/addItems/moveItem index into);
 *  - "play order": the order tracks will actually play (differs when shuffled).
 */

export type RepeatMode = 'off' | 'all' | 'one';

export interface Identified {
  id: string;
}

interface Entry<T> {
  key: number;
  item: T;
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

  // ---- loading -------------------------------------------------------------------

  /** Replace the queue with `items` and make `startIndex` current. */
  setList(items: T[], startIndex = 0): T | null {
    this.queued.clear();
    this.list = items.map((item) => this.entry(item));
    if (!this.list.length) {
      this.order = [];
      this.cur = null;
      return null;
    }
    const i = clamp(startIndex, 0, this.list.length - 1);
    this.cur = this.list[i];
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
      return 'moved';
    }
    if (this.repeat === 'all' && this.order.length > 1) {
      this.cur = this.order[this.order.length - 1];
      this.settle();
      return 'moved';
    }
    return 'restart';
  }

  /** Jump to a list index. */
  skipTo(index: number): T | null {
    const e = this.list[index];
    if (!e) return null;
    this.cur = e;
    this.settle();
    return e.item;
  }

  // ---- modes ---------------------------------------------------------------------

  setShuffle(on: boolean): void {
    this.shuffle = on;
    this.rebuildOrder();
  }

  setRepeat(mode: RepeatMode): void {
    this.repeat = mode;
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

  private entry(item: T): Entry<T> {
    return { key: this.nextKey++, item };
  }

  private rebuildOrder(): void {
    if (!this.shuffle) {
      this.order = this.list.slice();
      return;
    }
    // Queued tracks keep playing next, in the order they were added.
    const queued = this.list.filter((e) => e !== this.cur && this.queued.has(e));
    const rest = this.list.filter((e) => e !== this.cur && !this.queued.has(e));
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    this.order = this.cur ? [this.cur, ...queued, ...rest] : [...queued, ...rest];
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function inRange(i: number, a: unknown[]): boolean {
  return Number.isInteger(i) && i >= 0 && i < a.length;
}
