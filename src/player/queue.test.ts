import { describe, expect, it } from 'vitest';
import { KEEP_PLAYED, Queue } from './queue';

const t = (id: string) => ({ id });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const abc = () => ['a', 'b', 'c', 'd', 'e'].map(t);

/** Deterministic PRNG so shuffles are reproducible. */
function seeded(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x80000000;
  };
}

describe('Queue: play from list', () => {
  it('starts empty', () => {
    const q = new Queue();
    expect(q.current).toBeNull();
    expect(q.index).toBe(-1);
    expect(q.next()).toBeNull();
    expect(q.prev(0)).toBe('restart');
    expect(q.upNext()).toEqual([]);
  });

  it('plays from a list at an index', () => {
    const q = new Queue();
    expect(q.setList(abc(), 2)?.id).toBe('c');
    expect(q.index).toBe(2);
    expect(ids(q.upNext())).toEqual(['d', 'e']);
  });

  it('clamps the start index and handles an empty list', () => {
    const q = new Queue();
    expect(q.setList(abc(), 99)?.id).toBe('e');
    expect(q.setList([], 0)).toBeNull();
    expect(q.index).toBe(-1);
  });

  it('caps upNext', () => {
    const q = new Queue();
    q.setList(Array.from({ length: 80 }, (_, i) => t(String(i))), 0);
    expect(q.upNext()).toHaveLength(50);
    expect(q.upNext(3)).toHaveLength(3);
  });
});

describe('Queue: next / prev', () => {
  it('advances and stops at the end with repeat off', () => {
    const q = new Queue();
    q.setList(abc(), 3);
    expect(q.next()?.id).toBe('e');
    expect(q.next()).toBeNull();
    expect(q.current?.id).toBe('e');
  });

  it('wraps with repeat all (manual and auto)', () => {
    const q = new Queue();
    q.setList(abc(), 4);
    q.setRepeat('all');
    expect(q.next(true)?.id).toBe('a');
    q.skipTo(4);
    expect(q.next()?.id).toBe('a');
  });

  it('repeat one replays on auto-advance but skips on manual next', () => {
    const q = new Queue();
    q.setList(abc(), 1);
    q.setRepeat('one');
    expect(q.next(true)?.id).toBe('b');
    expect(q.next()?.id).toBe('c');
    q.skipTo(4);
    expect(q.next()?.id).toBe('a');
  });

  it('prev restarts when more than 3 s in', () => {
    const q = new Queue();
    q.setList(abc(), 2);
    expect(q.prev(3001)).toBe('restart');
    expect(q.current?.id).toBe('c');
  });

  it('prev moves back when within 3 s', () => {
    const q = new Queue();
    q.setList(abc(), 2);
    expect(q.prev(3000)).toBe('moved');
    expect(q.current?.id).toBe('b');
    expect(q.prev(0)).toBe('moved');
    expect(q.current?.id).toBe('a');
  });

  it('prev at the first track restarts, or wraps with repeat all', () => {
    const q = new Queue();
    q.setList(abc(), 0);
    expect(q.prev(0)).toBe('restart');
    expect(q.current?.id).toBe('a');
    q.setRepeat('all');
    expect(q.prev(0)).toBe('moved');
    expect(q.current?.id).toBe('e');
  });

  it('skipTo jumps by list index and ignores bad indices', () => {
    const q = new Queue();
    q.setList(abc(), 0);
    expect(q.skipTo(3)?.id).toBe('d');
    expect(q.skipTo(9)).toBeNull();
    expect(q.current?.id).toBe('d');
  });
});

describe('Queue: shuffle', () => {
  it('keeps the current track first and plays every track once', () => {
    const q = new Queue(seeded());
    q.setList(abc(), 2);
    q.setShuffle(true);
    expect(q.current?.id).toBe('c');
    expect(q.index).toBe(2);
    const played = ['c'];
    let n;
    while ((n = q.next())) played.push(n.id);
    expect(played.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('upNext follows play order while list order is unchanged', () => {
    const q = new Queue(seeded(7));
    q.setList(abc(), 0);
    q.setShuffle(true);
    expect(ids(q.items)).toEqual(['a', 'b', 'c', 'd', 'e']);
    const up = ids(q.upNext());
    expect(up.sort()).toEqual(['b', 'c', 'd', 'e']);
    expect(q.upNextIndices().map((i) => q.items[i].id)).toEqual(ids(q.upNext()));
  });

  it('setList while shuffled shuffles with the start track first', () => {
    const q = new Queue(seeded(3));
    q.setShuffle(true);
    q.setList(abc(), 4);
    expect(q.current?.id).toBe('e');
    expect(ids(q.upNext()).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('turning shuffle off resumes list order after the current track', () => {
    const q = new Queue(seeded(9));
    q.setList(abc(), 0);
    q.setShuffle(true);
    q.next();
    const cur = q.current!.id;
    q.setShuffle(false);
    expect(q.current?.id).toBe(cur);
    expect(ids(q.upNext())).toEqual(ids(q.items).slice(q.index + 1));
  });
});

describe('Queue: editing', () => {
  it('moves items in list order and keeps the current track', () => {
    const q = new Queue();
    q.setList(abc(), 1);
    q.move(4, 2);
    expect(ids(q.items)).toEqual(['a', 'b', 'e', 'c', 'd']);
    expect(q.current?.id).toBe('b');
    expect(q.index).toBe(1);
    expect(ids(q.upNext())).toEqual(['e', 'c', 'd']);
    q.move(1, 4);
    expect(q.index).toBe(4);
    expect(q.current?.id).toBe('b');
    q.move(0, 0);
    q.move(-1, 2);
    q.move(0, 9);
    expect(ids(q.items)).toEqual(['a', 'e', 'c', 'd', 'b']);
  });

  it('removes a non-current item', () => {
    const q = new Queue();
    q.setList(abc(), 2);
    expect(q.remove(0)).toBe(false);
    expect(ids(q.items)).toEqual(['b', 'c', 'd', 'e']);
    expect(q.index).toBe(1);
    expect(q.current?.id).toBe('c');
    expect(q.remove(42)).toBe(false);
  });

  it('removing the current item moves to the next, or the previous at the end', () => {
    const q = new Queue();
    q.setList(abc(), 2);
    expect(q.remove(2)).toBe(true);
    expect(q.current?.id).toBe('d');
    q.skipTo(3);
    expect(q.current?.id).toBe('e');
    expect(q.remove(3)).toBe(true);
    expect(q.current?.id).toBe('d');
  });

  it('removing the last item empties the queue', () => {
    const q = new Queue();
    q.setList([t('a')], 0);
    q.remove(0);
    expect(q.current).toBeNull();
    expect(q.length).toBe(0);
  });

  it('queueNext inserts right after the current track', () => {
    const q = new Queue();
    q.setList(abc(), 1);
    q.queueNext([t('x'), t('y')]);
    expect(ids(q.items)).toEqual(['a', 'b', 'x', 'y', 'c', 'd', 'e']);
    expect(ids(q.upNext(2))).toEqual(['x', 'y']);
    expect(q.queuedCount).toBe(2);
    expect(q.next()?.id).toBe('x');
    expect(q.queuedCount).toBe(1);
  });

  it('queueNext is first in, first out: A then B gives A, B, then the rest', () => {
    const q = new Queue();
    q.setList(abc(), 0);
    q.queueNext([t('A')]);
    q.queueNext([t('B')]);
    expect(ids(q.upNext())).toEqual(['A', 'B', 'b', 'c', 'd', 'e']);
    q.next(); // A plays
    q.queueNext([t('C')]);
    expect(ids(q.upNext())).toEqual(['B', 'C', 'b', 'c', 'd', 'e']);
    q.next();
    q.next();
    expect(q.queuedCount).toBe(0);
    q.queueNext([t('D')]);
    expect(ids(q.upNext(2))).toEqual(['D', 'b']);
  });

  it('queueNext plays next with shuffle on, in order, and survives reshuffles', () => {
    const q = new Queue(seeded(5));
    q.setList(abc(), 0);
    q.setShuffle(true);
    q.queueNext([t('x')]);
    q.queueNext([t('y')]);
    expect(ids(q.upNext(2))).toEqual(['x', 'y']);
    q.setShuffle(false);
    expect(ids(q.upNext(2))).toEqual(['x', 'y']);
    q.setShuffle(true);
    expect(ids(q.upNext(2))).toEqual(['x', 'y']);
    expect(q.queuedCount).toBe(2);
  });

  it('removing a queued track forgets it; a new list keeps the rest (P1)', () => {
    const q = new Queue();
    q.setList(abc(), 0);
    q.queueNext([t('x'), t('y')]);
    q.remove(1);
    expect(q.queuedCount).toBe(1);
    q.setList(abc(), 0);
    expect(q.queuedCount).toBe(1);
    expect(ids(q.upNext(2))).toEqual(['y', 'b']);
  });

  it('restore puts a removed list track back before the track that followed it (Undo)', () => {
    const q = new Queue();
    q.setList(abc(), 0);
    q.addAuto([t('s1')]);
    q.remove(2);
    q.restore(t('c'), 'list', 'd');
    expect(ids(q.upNext())).toEqual(['b', 'c', 'd', 'e', 's1']);
    expect(ids(q.items)).toEqual(['a', 'b', 'c', 'd', 'e', 's1']);
    const r = new Queue(seeded(3));
    r.setList(abc(), 0);
    r.setShuffle(true);
    r.addAuto([t('s1')]);
    r.restore(t('z'), 'list', null);
    expect(ids(r.upNext()).at(-1)).toBe('s1');
    expect(ids(r.upNext()).at(-2)).toBe('z');
  });

  it('restore after another Add to queue: the list track stays out of the queued run', () => {
    const q = new Queue();
    q.setList([t('A'), t('B'), t('C')], 0);
    q.queueNext([t('Q1')]);
    q.remove(2); // B
    q.queueNext([t('Q2')]);
    q.restore(t('B'), 'list', 'C');
    expect(ids(q.upNext())).toEqual(['Q1', 'Q2', 'B', 'C']);
    expect(q.queuedCount).toBe(2);
  });

  it('restore after the track moved on: never behind the current track', () => {
    const q = new Queue();
    q.setList([t('A'), t('B'), t('C'), t('D')], 0);
    q.remove(1); // B, followed by C
    q.next(true); // A ended: C plays
    q.restore(t('B'), 'list', 'C');
    expect(q.current?.id).toBe('C');
    expect(ids(q.upNext())).toEqual(['D', 'B']);
  });

  it('restore of a queued track goes back into the queued run, in place', () => {
    const q = new Queue();
    q.setList(abc(), 0);
    q.queueNext([t('x'), t('y'), t('z')]);
    q.remove(2); // y
    q.restore(t('y'), 'queued', 'z');
    expect(ids(q.upNext())).toEqual(['x', 'y', 'z', 'b', 'c', 'd', 'e']);
    expect(q.queuedCount).toBe(3);
    q.remove(3); // z, the last queued
    q.restore(t('z'), 'queued', 'gone');
    expect(ids(q.upNext())).toEqual(['x', 'y', 'z', 'b', 'c', 'd', 'e']);
    expect(q.queuedCount).toBe(3);
  });

  it('restore of an autoplay track goes back into autoplay', () => {
    const q = new Queue();
    q.setList([t('a'), t('b')], 0);
    q.addAuto([t('s1'), t('s2'), t('s3')]);
    q.remove(3); // s2
    q.restore(t('s2'), 'autoplay', 's3');
    expect(q.sections().autoplay.map((x) => x.item.id)).toEqual(['s1', 's2', 's3']);
    q.remove(4); // s3
    q.restore(t('s3'), 'autoplay', null);
    expect(q.sections().autoplay.map((x) => x.item.id)).toEqual(['s1', 's2', 's3']);
  });

  it('removeIds drops every copy; the current one moves on to the next that stays', () => {
    const q = new Queue();
    q.setList([t('a'), t('m'), t('b'), t('m2')], 1);
    q.queueNext([t('m2')]);
    expect(q.removeIds(['m', 'm2'])).toBe(true);
    expect(q.current?.id).toBe('b');
    expect(ids(q.items)).toEqual(['a', 'b']);
    expect(q.queuedCount).toBe(0);
    expect(q.removeIds(['nope'])).toBe(false);
    expect(q.removeIds(['a', 'b'])).toBe(true);
    expect(q.current).toBeNull();
    expect(q.length).toBe(0);
  });

  it(`keeps at most ${KEEP_PLAYED} tracks behind the current one: older played autoplay tracks go`, () => {
    const q = new Queue();
    q.setList([t('a'), t('b')], 0);
    const autos = Array.from({ length: KEEP_PLAYED + 20 }, (_, i) => t(`s${i}`));
    q.addAuto(autos);
    for (let i = 0; i < KEEP_PLAYED + 10; i++) q.next(true);
    expect(q.current?.id).toBe(`s${KEEP_PLAYED + 8}`);
    // The list tracks stay (they're within the oldest); only played autoplay tracks went.
    expect(ids(q.items).slice(0, 3)).toEqual(['a', 'b', 's8']);
    expect(q.index).toBe(KEEP_PLAYED + 2);
    expect(q.upNext()).toHaveLength(11);
  });

  it('add appends to list and play order', () => {
    const q = new Queue(seeded(5));
    q.setList(abc(), 0);
    q.setShuffle(true);
    q.add([t('z')]);
    expect(q.items.at(-1)?.id).toBe('z');
    expect(q.upNext().at(-1)?.id).toBe('z');
  });

  it('queueNext / add on an empty queue makes the first item current', () => {
    const q = new Queue();
    q.add([t('a'), t('b')]);
    expect(q.current?.id).toBe('a');
    const q2 = new Queue();
    q2.queueNext([t('x'), t('y')]);
    expect(q2.current?.id).toBe('x');
    expect(q2.queuedCount).toBe(1);
  });

  it('allows the same track twice and tracks them independently', () => {
    const q = new Queue();
    q.setList([t('a'), t('b')], 0);
    q.add([t('a')]);
    q.skipTo(2);
    expect(q.index).toBe(2);
    q.remove(0);
    expect(q.index).toBe(1);
    expect(q.current?.id).toBe('a');
  });

  it('clear empties everything', () => {
    const q = new Queue();
    q.setList(abc(), 0);
    q.clear();
    expect(q.length).toBe(0);
    expect(q.current).toBeNull();
  });
});
