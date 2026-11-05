/** Runs the shared queue rule table (also run against the native queue by QueueRulesTest). */
import { describe, expect, it } from 'vitest';
import rules from '../../tests/spec/queue-rules.json';
import { Queue } from './queue';
import type { RepeatMode } from './native';
import type { Track } from '../data/model';
import { EMPTY_STATE, placeOf, sectionsOf, type UpItem, type UpNextKind as Section } from './types';

type Step = { op: string; [k: string]: unknown };
interface Case {
  name: string;
  list: string[];
  start: number;
  shuffle?: boolean;
  repeat?: RepeatMode;
  steps: Step[];
}

function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x80000000;
  };
}

const t = (id: string) => ({ id });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('Queue rules (tests/spec/queue-rules.json)', () => {
  for (const c of rules.cases as Case[]) {
    it(c.name, () => {
      const q = new Queue(seeded());
      if (c.shuffle) q.setShuffle(true);
      if (c.repeat) q.setRepeat(c.repeat);
      if (c.list.length) q.setList(c.list.map(t), c.start);
      const indexOf = (id: unknown) => {
        const i = q.items.findIndex((x) => x.id === id);
        expect(i, `${String(id)} in list`).toBeGreaterThanOrEqual(0);
        return i;
      };
      // Up next as the app builds it from what the player publishes.
      const upNext = () => q.upNextItems().map(({ item, ...u }) => ({ track: item as Track, ...u }));
      let undo: [string, Section, string | null, boolean] | null = null;
      let top: string[] = [];
      for (const s of c.steps) {
        switch (s.op) {
          case 'setList':
            q.setList((s.ids as string[]).map(t), s.start as number);
            break;
          case 'queueNext':
            q.queueNext((s.ids as string[]).map(t));
            break;
          case 'addAuto':
            q.addAuto((s.ids as string[]).map(t), s.joinList === true);
            break;
          case 'skipTo':
            q.skipTo(indexOf(s.id), s.lap === true);
            break;
          case 'next':
            q.next(false);
            break;
          case 'nextAuto':
            q.next(true);
            break;
          case 'prev':
            q.prev((s.positionMs as number) ?? 0);
            break;
          case 'remove':
            q.remove(indexOf(s.id));
            break;
          case 'move':
            q.move(indexOf(s.id), s.to as number);
            break;
          case 'restore':
            q.restore(t(s.id as string), s.kind as Section, (s.beforeId as string | null) ?? null, s.mine === true);
            break;
          case 'removeRow': {
            // Up next's ✕: Undo puts it back as its row's kind, before the row that followed it.
            const rows = upNext();
            const k = rows.findIndex((u) => u.track.id === s.id);
            const { kind } = sectionsOf(rows, null).runs.find((r) => r.items.some((u) => u.index === rows[k].index))!;
            undo = [s.id as string, kind, rows[k + 1]?.track.id ?? null, q.mineIndices().includes(rows[k].index)];
            q.remove(rows[k].index);
            break;
          }
          case 'undo':
            q.restore(t(undo![0]), undo![1], undo![2], undo![3]);
            break;
          case 'removeIds':
            q.removeIds(s.ids as string[]);
            break;
          case 'keepTop': {
            // The next lap ("From the top"): the play order from its first song to the current one, without the songs you queued.
            const mine = new Set(q.mineIndices());
            top = [...q.previousIndices(), q.index].filter((i) => !mine.has(i)).map((i) => q.items[i].id);
            break;
          }
          case 'dropOnTheWay':
            q.dropOnTheWay();
            break;
          case 'setShuffle':
            q.setShuffle(s.on as boolean);
            break;
          case 'setRepeat':
            q.setRepeat(s.mode as RepeatMode);
            break;
          case 'expect': {
            if ('current' in s) expect(q.current?.id ?? null).toBe(s.current);
            if ('upNext' in s) expect(ids(q.upNext())).toEqual(s.upNext);
            if ('upNextBlocks' in s) {
              // Each block's songs in any order (a shuffled block); the blocks in order.
              const blocks = s.upNextBlocks as string[][];
              let at = 0;
              const up = ids(q.upNext());
              for (const b of blocks) expect(up.slice(at, (at += b.length)).sort()).toEqual(b.slice().sort());
              expect(up.length).toBe(at);
            }
            if ('upNextStartsWith' in s) {
              const want = s.upNextStartsWith as string[];
              expect(ids(q.upNext()).slice(0, want.length)).toEqual(want);
            }
            if ('listStart' in s) expect(q.items[q.listStartIndex]?.id).toBe(s.listStart);
            if ('queued' in s) expect(q.queuedCount).toBe(s.queued);
            if ('list' in s) expect(ids(q.items)).toEqual(s.list);
            if ('played' in s) expect(q.previousIndices().map((i) => q.items[i].id)).toEqual(s.played);
            if ('mine' in s) expect(q.mineIndices().map((i) => q.items[i].id)).toEqual(s.mine);
            if ('upNextIsKeptTop' in s) expect([q.current?.id, ...ids(q.upNext())]).toEqual(top);
            const lap = () => q.lapIndices().map((i) => q.items[i].id);
            if ('top' in s) expect(lap()).toEqual(s.top);
            if ('topSet' in s) expect(lap().sort()).toEqual((s.topSet as string[]).slice().sort());
            if ('place' in s) expect(placeOf({ ...EMPTY_STATE, queue: q.items as Track[], index: q.index, upNext: upNext() })).toBe(s.place);
            const sec = sectionsOf(upNext(), null);
            const sIds = (xs: UpItem[]) => xs.map((x) => x.track.id);
            if ('queuedIds' in s) expect(sIds(sec.queued)).toEqual(s.queuedIds);
            if ('listIds' in s) expect(sIds(sec.list)).toEqual(s.listIds);
            if ('listSet' in s) expect(sIds(sec.list).sort()).toEqual((s.listSet as string[]).slice().sort());
            if ('autoplayIds' in s) expect(sIds(sec.autoplay)).toEqual(s.autoplayIds);
            if ('autoplaySet' in s) expect(sIds(sec.autoplay).sort()).toEqual((s.autoplaySet as string[]).slice().sort());
            break;
          }
          default:
            throw new Error(`unknown op ${s.op}`);
        }
      }
    });
  }
});
