/** Runs the shared queue rule table (also run against the native queue by QueueRulesTest). */
import { describe, expect, it } from 'vitest';
import rules from '../../tests/spec/queue-rules.json';
import { Queue } from './queue';
import type { RepeatMode } from './native';
import type { UpNextKind as Section } from './types';

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
      for (const s of c.steps) {
        switch (s.op) {
          case 'setList':
            q.setList((s.ids as string[]).map(t), s.start as number);
            break;
          case 'queueNext':
            q.queueNext((s.ids as string[]).map(t));
            break;
          case 'addAuto':
            q.addAuto((s.ids as string[]).map(t));
            break;
          case 'skipTo':
            q.skipTo(indexOf(s.id));
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
            q.restore(t(s.id as string), s.kind as Section, (s.beforeId as string | null) ?? null);
            break;
          case 'removeIds':
            q.removeIds(s.ids as string[]);
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
            if ('upNextStartsWith' in s) {
              const want = s.upNextStartsWith as string[];
              expect(ids(q.upNext()).slice(0, want.length)).toEqual(want);
            }
            if ('queued' in s) expect(q.queuedCount).toBe(s.queued);
            if ('list' in s) expect(ids(q.items)).toEqual(s.list);
            const sec = q.sections();
            const sIds = (xs: { item: { id: string } }[]) => xs.map((x) => x.item.id);
            if ('queuedIds' in s) expect(sIds(sec.queued)).toEqual(s.queuedIds);
            if ('listIds' in s) expect(sIds(sec.list)).toEqual(s.listIds);
            if ('listSet' in s) expect(sIds(sec.list).sort()).toEqual((s.listSet as string[]).slice().sort());
            if ('autoplayIds' in s) expect(sIds(sec.autoplay)).toEqual(s.autoplayIds);
            break;
          }
          default:
            throw new Error(`unknown op ${s.op}`);
        }
      }
    });
  }
});
