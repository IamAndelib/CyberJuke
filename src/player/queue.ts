/**
 * Pure, synchronous play-queue model used by the WebPlayer (the native side owns
 * its own queue). No I/O, no timers: every method mutates the model and returns
 * what the caller should do next.
 *
 * Terms (mirroring the native plugin contract):
 *  - "list": the queue in list order (what setQueue/moveItem index into);
 *  - "play order": the order tracks will actually play (differs when shuffled).
 *
 * The rules (shared with the native queue; the cases both must pass are in
 * tests/spec/queue-rules.json):
 *  - queued tracks play right after the current track, first in first out, shuffle
 *    or not, until each one plays or is removed;
 *  - a manual jump (skipTo, or prev moving back) to a track that isn't one of them
 *    keeps them next: they move to just after the new current track, in the order
 *    they were going to play. Jumping to one of them plays it; the others stay next.
 *    A jump ahead keeps what it jumps over in Up next: the track moves next, then plays;
 *  - a new list (setList) replaces the list and the autoplay tracks, but the queued
 *    tracks stay next, in order (P1);
 *  - autoplay tracks (addAuto) play after the list, in the order added; they are the list on
 *    the way, and moving on to one of them (played on to, or tapped) makes the current list start
 *    at it or at the first of them, whichever comes first in list order (listStartIndex; the songs
 *    before it are history; shuffled, the batch's songs before it stay ahead, and a tap brings the
 *    list's unheard songs it jumped over along, at the new list's start, as an unshuffled tap). A
 *    radio's first suggestions join its list instead (joinList). Repeat all loops the list you're in: turning it on drops
 *    what's on the way (it comes back once repeat is off) and the songs before the current list,
 *    keeping the playing song and the queued ones, and autoplay adds nothing while it is on
 *    (mayAutoplay). Turning autoplay off drops what's on the way too, never the list you're in.
 *    Repeat one leaves them: it replays the track when it ends, and a skip moves on as with
 *    repeat off (none at the end, as Media3's). Jumping to an autoplay track keeps the ones
 *    after it (Spotify, YouTube Music): more follow it once they run low;
 *  - played autoplay tracks more than KEEP_PLAYED behind the current one are dropped (a
 *    radio can run for hours), except with repeat all, which loops them, and those at or
 *    after where the current list starts. A removed marker's song hands it to the next one;
 *    an Undo puts a song back in its own list: a marker's own song gets the marker back;
 *  - Undo of a remove (restore) puts the track back as its own kind, before the track that
 *    followed it in Up next (a queued one only among the queued, the others never among them),
 *    never at or before the current track; a played track goes back among the played, before
 *    the one that followed it, else right before the current;
 *  - "played" is what was heard before the current track: the tracks of this list before it in
 *    play order that have been current (a list started mid-way hasn't played the ones before
 *    it). Shuffle turned on mixes what hasn't played: what Played shows stays behind, in the
 *    order it played, and everything else is mixed ahead (Up next, and the list tracks before
 *    where the list started), the list's ahead of the autoplay ones; new autoplay tracks go at
 *    the end, mixed among themselves. Off puts the list order back.
 *
 * Up next labels each track by its own kind, never by its place: queued by you, the
 * list, autoplay (sectionsOf in ./types).
 */
import { UP_NEXT_MAX } from '../core/guards';
import { shuffled } from '../core/shuffle';
import type { RepeatMode } from './native';
import type { UpNextKind as Section } from './types';

interface Identified {
  id: string;
}

interface Entry<T> {
  key: number;
  item: T;
  /** Added by autoplay (addAuto). */
  auto?: boolean;
}

const RESTART_THRESHOLD_MS = 3000;
/** Tracks kept behind the current one in play order; older played autoplay tracks go. */
export const KEEP_PLAYED = 50;


type PrevResult = 'restart' | 'moved';

export class Queue<T extends Identified> {
  private list: Entry<T>[] = [];
  private order: Entry<T>[] = [];
  private cur: Entry<T> | null = null;
  /** Entries added with queueNext() that haven't become current yet. */
  private queued = new Set<Entry<T>>();
  /** Entries of this list that have been current: heard ("Played" shows the ones before the current one). */
  private heard = new Set<Entry<T>>();
  /** Where the current list starts (null: its first song) and where the one on the way does (null: none). */
  private listStart: Entry<T> | null = null;
  private nextStart: Entry<T> | null = null;
  /** The ids of the songs the markers last left because they were removed (until moving on): an Undo of one gives it its marker back. */
  private listLeft: string | null = null;
  private nextLeft: string | null = null;
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
  upNext(max = UP_NEXT_MAX): T[] {
    if (!this.cur) return this.order.slice(0, max).map((e) => e.item);
    const p = this.order.indexOf(this.cur);
    return this.order.slice(p + 1, p + 1 + max).map((e) => e.item);
  }

  /** List indices of upNext(), so a UI can address items in list order. */
  upNextIndices(max = UP_NEXT_MAX): number[] {
    const p = this.cur ? this.order.indexOf(this.cur) : -1;
    return this.order.slice(p + 1, p + 1 + max).map((e) => this.list.indexOf(e));
  }

  /** List indices of the tracks before the current one in play order, oldest first, at most `max`. */
  previousIndices(max = UP_NEXT_MAX): number[] {
    return this.played().slice(-max).map((e) => this.list.indexOf(e));
  }

  /** How many of the first upNext() items were queued by the user ("Queued by you"). */
  get queuedCount(): number {
    const p = this.cur ? this.order.indexOf(this.cur) : -1;
    let n = 0;
    while (p + 1 + n < this.order.length && this.queued.has(this.order[p + 1 + n])) n++;
    return n;
  }

  /** List index of the current list's first song. */
  get listStartIndex(): number {
    return Math.max(0, this.list.indexOf(this.listStart!));
  }

  /** List index of the first song of the list on the way, -1 if none. */
  get nextStartIndex(): number {
    return this.list.indexOf(this.nextStart!);
  }

  /** Whether the item at a list index was added by autoplay. */
  isAuto(index: number): boolean {
    return this.list[index]?.auto === true;
  }

  /** Tracks still to come (after the current one in play order). */
  get ahead(): number {
    return this.order.length - 1 - (this.cur ? this.order.indexOf(this.cur) : -1);
  }

  /**
   * Up next (at most `max` tracks), in play order, as the player publishes it: each with its
   * list index, `queued` for the leading run queued by the user, `auto` for autoplay.
   */
  upNextItems(max = UP_NEXT_MAX): { item: T; index: number; queued?: true; auto?: true }[] {
    const n = this.queuedCount;
    return this.upNextIndices(max).map((index, k) =>
      k < n ? { item: this.list[index].item, index, queued: true } : this.list[index].auto ? { item: this.list[index].item, index, auto: true } : { item: this.list[index].item, index },
    );
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
    this.heard = new Set();
    this.listStart = this.nextStart = null;
    this.listLeft = this.nextLeft = null;
    this.cur = this.list[i];
    this.settle();
    this.list.splice(i + 1, 0, ...kept);
    this.rebuildOrder();
    return this.cur.item;
  }

  // ---- navigation ----------------------------------------------------------------

  /**
   * Advance. `auto` is true when the current track ended by itself (repeat-one then
   * replays it); a user "next" moves on, as Media3's: at the end of the queue only with
   * repeat all, to its start. Returns the new current track, or null when there is none.
   */
  next(auto = false): T | null {
    if (!this.cur) return null;
    if (auto && this.repeat === 'one') return this.cur.item;
    const p = this.order.indexOf(this.cur);
    if (p + 1 < this.order.length) {
      this.cur = this.order[p + 1];
      this.settle();
      this.trimPlayed();
      return this.cur.item;
    }
    if (this.repeat === 'all') {
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
   * Jump to a list index. A track further ahead plays now and what it jumps over stays in Up
   * next (YouTube Music): it moves to right after the current one first. Tracks still queued
   * stay next (see the rule above); so do the autoplay tracks after an autoplay track jumped to. Shuffled, a
   * jump that moves on brings the current list's unheard songs along (the rule above).
   */
  skipTo(index: number): T | null {
    const e = this.list[index];
    if (!e) return null;
    const on = this.movesOn(e);
    const p = this.cur ? this.order.indexOf(this.cur) : -1;
    if (p >= 0 && this.order.indexOf(e) > p + 1) {
      const at = (arr: Entry<T>[]) => {
        arr.splice(arr.indexOf(e), 1);
        arr.splice(arr.indexOf(this.cur!) + 1, 0, e);
      };
      at(this.order);
      if (!this.shuffle) at(this.list);
    }
    // Shuffled, the list's unheard songs it jumped over come along: they go just before the list on the way, which starts at them.
    const kept = on && this.shuffle ? this.list.slice(this.listStartIndex, this.nextStartIndex).filter((x) => !this.heard.has(x) && !this.queued.has(x)) : [];
    if (kept.length) {
      this.list = this.list.filter((x) => !kept.includes(x));
      this.list.splice(this.nextStartIndex, 0, ...kept);
      this.nextStart = kept[0];
    }
    this.cur = e;
    this.settle(on);
    this.keepQueuedNext();
    this.trimPlayed();
    return e.item;
  }

  // ---- modes ---------------------------------------------------------------------

  setShuffle(on: boolean): void {
    if (on === this.shuffle) return;
    this.shuffle = on;
    this.rebuildOrder(true);
  }

  /** Repeat all loops the list you're in: what's on the way and the history before it go (not the playing song or the queued ones). */
  setRepeat(mode: RepeatMode): void {
    this.repeat = mode;
    if (mode !== 'all') return;
    this.dropOnTheWay();
    this.drop((i) => i < this.listStartIndex);
  }

  // ---- editing -------------------------------------------------------------------

  /**
   * Move an item in list order, to where the item at `to` was. Unshuffled, it moves the same way in
   * play order (which differs from list order after shuffle was turned off).
   */
  move(from: number, to: number): void {
    if (!inRange(from, this.list) || !inRange(to, this.list) || from === to) return;
    const target = this.list[to];
    const [e] = this.list.splice(from, 1);
    this.list.splice(to, 0, e);
    if (this.shuffle) return;
    this.order.splice(this.order.indexOf(e), 1);
    this.order.splice(this.order.indexOf(target) + (from < to ? 1 : 0), 0, e);
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
    this.unmark(new Set([e]));
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
      this.settle();
      for (const e of entries.slice(1)) this.queued.add(e);
      return;
    }
    this.list.splice(this.afterQueued(this.list), 0, ...entries);
    this.order.splice(this.afterQueued(this.order), 0, ...entries);
    for (const e of entries) this.queued.add(e);
  }

  /**
   * Autoplay: append tracks after everything else, in list and play order (with shuffle on,
   * mixed among themselves). With nothing playing, the first one becomes current. They are the
   * list on the way, unless `joinList` (a radio's first ones) or one is on the way already.
   */
  addAuto(items: T[], joinList = false): void {
    if (!items.length) return;
    const entries = items.map((i) => ({ ...this.entry(i), auto: true }));
    const added = this.shuffle && this.cur ? shuffled(entries, this.rand) : entries;
    this.list.push(...entries);
    this.order.push(...added);
    if (!joinList) this.nextStart ??= entries[0];
    if (!this.cur) {
      this.cur = entries[0];
      this.settle();
    }
  }

  /** Remove the list on the way (its songs that aren't queued): autoplay off, or repeat all. */
  dropOnTheWay(): void {
    const way = this.nextStartIndex;
    if (way >= 0) this.drop((i) => i >= way);
    this.nextStart = null;
  }

  /**
   * Undo of a remove: put `item` back as `kind`, right before the first track after the current
   * one that is `beforeId` (a queued one only before a queued one, the others never before one);
   * else at the end of its section: after the queued run, after the last list track ahead (else
   * the queued run), or at the very end. Never at or before the current track. A played one goes
   * back before the played track `beforeId`, else right before the current one. In list order
   * (what shuffle off plays) it goes before the track that follows it; shuffled, a queued one goes
   * after the queued run there and a list one before the autoplay tracks of the list you're in (as
   * the native queue's), so both stay ahead once shuffle is off. A marker's own song, back right
   * before the marker's song (or last, the marker gone with it), gets the marker back: it stays in
   * its own list. With nothing playing, it is added (and plays).
   */
  restore(item: T, kind: Section, beforeId: string | null): void {
    if (!this.cur) {
      if (kind === 'queued') this.queueNext([item]);
      else if (kind === 'autoplay') this.addAuto([item]);
      else this.add([item]);
      return;
    }
    const of = (e: Entry<T>): Section => (this.queued.has(e) ? 'queued' : e.auto ? 'autoplay' : 'list');
    const p = this.order.indexOf(this.cur);
    const played = kind === 'played';
    let at = -1;
    if (beforeId != null) at = this.order.findIndex((e, k) => (played ? k < p : k > p && (of(e) === 'queued') === (kind === 'queued')) && e.item.id === beforeId);
    if (at < 0 && played) at = p;
    if (at < 0) {
      // The end of the section: after its last track ahead, else where it would start.
      at = p + 1 + this.queuedCount;
      if (kind === 'autoplay') at = this.order.length;
      else if (kind === 'list') for (let k = at; k < this.order.length; k++) if (of(this.order[k]) === 'list') at = k + 1;
    }
    const entry: Entry<T> = kind === 'autoplay' ? { ...this.entry(item), auto: true } : this.entry(item);
    if (kind === 'queued') this.queued.add(entry);
    if (played) this.heard.add(entry);
    const follower = this.order[at];
    this.order.splice(at, 0, entry);
    const firstAuto = this.list.findIndex((e, i) => e.auto && i > this.listStartIndex);
    let li = follower ? this.list.indexOf(follower) : this.list.length;
    if (this.shuffle && kind === 'queued') li = this.afterQueued(this.list);
    if (this.shuffle && kind === 'list') li = firstAuto < 0 ? this.list.length : firstAuto;
    this.list.splice(li, 0, entry);
    if (kind === 'queued') return;
    // A marker's own song back right before the marker's song now (or last, the marker gone with it) takes it back.
    const after = this.list[li + 1] ?? null;
    if (after === this.listStart && item.id === this.listLeft) this.listStart = entry;
    if (after === this.nextStart && item.id === this.nextLeft) this.nextStart = entry;
  }

  /**
   * Remove every item with one of these ids (signing out drops members-only tracks).
   * When the current one goes, the next one in play order that stays becomes current
   * (none: nothing plays). Returns true when the current track changed.
   */
  removeIds(ids: Iterable<string>): boolean {
    const gone = new Set(ids);
    if (!this.list.some((e) => gone.has(e.item.id))) return false;
    let changed = false;
    if (this.cur && gone.has(this.cur.item.id)) {
      const p = this.order.indexOf(this.cur);
      this.cur = this.order.slice(p + 1).find((e) => !gone.has(e.item.id)) ?? null;
      this.settle();
      changed = true;
    }
    const keep = (e: Entry<T>) => !gone.has(e.item.id);
    this.unmark(new Set(this.list.filter((e) => !keep(e))));
    for (const e of this.list) if (!keep(e)) this.queued.delete(e);
    this.list = this.list.filter(keep);
    this.order = this.order.filter(keep);
    return changed;
  }

  /** Append tracks to the end of the queue (in list and play order). */
  add(items: T[]): void {
    if (!items.length) return;
    const entries = items.map((i) => this.entry(i));
    this.list.push(...entries);
    this.order.push(...entries);
    if (!this.cur) {
      this.cur = entries[0];
      this.settle();
    }
  }

  clear(): void {
    this.queued.clear();
    this.heard.clear();
    this.list = [];
    this.order = [];
    this.cur = null;
    this.listStart = this.nextStart = null;
    this.listLeft = this.nextLeft = null;
  }

  // ---- internals -----------------------------------------------------------------

  /**
   * Drop played autoplay tracks more than KEEP_PLAYED behind the current one in play order (not in repeat
   * all's loop), but none of the current list: those before where it starts in list order (shuffled, its
   * songs play in any order).
   */
  private trimPlayed(): void {
    if (this.repeat === 'all') return;
    const p = this.cur ? this.order.indexOf(this.cur) : -1;
    if (p <= KEEP_PLAYED) return;
    const start = this.listStart ? this.listStartIndex : Infinity;
    const old = new Set(this.order.slice(0, p - KEEP_PLAYED).filter((e) => e.auto && this.list.indexOf(e) < start));
    if (!old.size) return;
    this.list = this.list.filter((e) => !old.has(e));
    this.order = this.order.filter((e) => !old.has(e));
  }

  /** Remove the entries `gone` picks by list index, except the playing one and the queued ones. */
  private drop(gone: (i: number) => boolean): void {
    const out = new Set(this.list.filter((e, i) => e !== this.cur && !this.queued.has(e) && gone(i)));
    this.list = this.list.filter((e) => !out.has(e));
    this.order = this.order.filter((e) => !out.has(e));
  }

  /** The tracks before the current one in play order that were heard: what Played shows. */
  private played(): Entry<T>[] {
    return this.order.slice(0, this.cur ? this.order.indexOf(this.cur) : 0).filter((e) => this.heard.has(e));
  }

  /** Whether making `e` current moves on: it is on the way, from its first song to the end of the list (shuffle never reorders the list). */
  private movesOn(e: Entry<T>): boolean {
    return !!this.nextStart && this.list.indexOf(e) >= this.list.indexOf(this.nextStart);
  }

  /** A marker's song is going: the marker moves to the next in list order that stays (none: unset). */
  private unmark(gone: ReadonlySet<Entry<T>>): void {
    if (this.listStart && gone.has(this.listStart)) this.listLeft = this.listStart.item.id;
    if (this.nextStart && gone.has(this.nextStart)) this.nextLeft = this.nextStart.item.id;
    const next = (m: Entry<T> | null) => (m && gone.has(m) ? this.list.slice(this.list.indexOf(m) + 1).find((e) => !gone.has(e)) ?? null : m);
    this.listStart = next(this.listStart);
    this.nextStart = next(this.nextStart);
  }

  /**
   * The current entry changed: it is heard, a queued track that starts playing is no longer "queued",
   * and moving on starts the current list at it or at the first song on the way, whichever comes first
   * in list order (shuffled, that keeps the batch's songs before it ahead; `on`: skipTo works it out before it reorders).
   */
  private settle(on = this.cur !== null && this.movesOn(this.cur)): void {
    if (!this.cur) return;
    if (on) [this.listStart, this.nextStart, this.listLeft, this.nextLeft] = [this.list.indexOf(this.nextStart!) < this.list.indexOf(this.cur) ? this.nextStart : this.cur, null, null, null];
    this.queued.delete(this.cur);
    this.heard.add(this.cur);
  }

  /** The index in `arr` (the list or the play order) right after the current track and the queued run after it. */
  private afterQueued(arr: Entry<T>[]): number {
    let k = arr.indexOf(this.cur!) + 1;
    while (k < arr.length && this.queued.has(arr[k])) k++;
    return k;
  }

  /** Move the still-queued tracks to just after the current one, keeping their play order. */
  private keepQueuedNext(pending = this.order.filter((e) => this.queued.has(e))): void {
    const cur = this.cur;
    if (!cur || !this.queued.size) return;
    const isPending = (e: Entry<T>) => this.queued.has(e);
    this.list = this.list.filter((e) => !isPending(e));
    this.order = this.order.filter((e) => !isPending(e));
    this.list.splice(this.list.indexOf(cur) + 1, 0, ...pending);
    this.order.splice(this.order.indexOf(cur) + 1, 0, ...pending);
  }

  private entry(item: T): Entry<T> {
    return { key: this.nextKey++, item };
  }

  /**
   * Shuffle on. [keepPlayed] (shuffle turned on or off): what Played shows stays behind the current
   * one, in the order it played, and all the others are mixed ahead (Spotify, YouTube Music): Up
   * next, also the ones before where the list started. Queued tracks play next, in the order added;
   * then the current list, mixed; then what's on the way, mixed on its own (YouTube Music's radio
   * shuffles). Shuffle off puts the list order back, but the current list's unheard songs before
   * the current one go right after the queued run, in list order: turning shuffle off skips none.
   */
  private rebuildOrder(keepPlayed = false): void {
    // The queued tracks, as they were going to play: they stay next, in that order, either way
    // (the list may hold them elsewhere: an Undo while shuffled puts one back by play order).
    const queued = this.order.filter((e) => e !== this.cur && this.queued.has(e));
    const cur = this.cur;
    if (!this.shuffle) {
      this.order = this.list.slice();
      this.keepQueuedNext(queued);
      const unheard = keepPlayed && cur ? this.list.slice(this.listStartIndex, this.list.indexOf(cur)).filter((e) => !this.heard.has(e) && !this.queued.has(e)) : [];
      if (unheard.length) {
        this.order = this.order.filter((e) => !unheard.includes(e));
        this.order.splice(this.afterQueued(this.order), 0, ...unheard);
      }
      return;
    }
    const played = keepPlayed ? this.played() : [];
    const ahead = this.list.filter((e) => e !== cur && !this.queued.has(e) && !played.includes(e));
    // Blocks by list index: the songs before where the list started, the current list, what's on the way.
    const [start, way] = [this.listStartIndex, this.nextStartIndex];
    const block = (e: Entry<T>) => (way >= 0 && this.list.indexOf(e) >= way ? 2 : this.list.indexOf(e) >= start ? 1 : 0);
    this.order = [
      ...played,
      ...(cur ? [cur] : []),
      ...queued,
      ...[0, 1, 2].flatMap((b) => shuffled(ahead.filter((e) => block(e) === b), this.rand)),
    ];
  }

}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function inRange(i: number, a: unknown[]): boolean {
  return Number.isInteger(i) && i >= 0 && i < a.length;
}
