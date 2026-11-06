import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../data/model';
import { WebPlayer } from './webPlayer';
import { firstBatchOfRadio } from './types';

const t = (id: string) => ({ id, title: id }) as Track;
const radio = (label: string) => ({ label, mode: 'radio' as const });

vi.stubGlobal('window', {});

async function started(repeat: 'off' | 'all', mode: 'radio' | 'list' = 'radio') {
  const p = new WebPlayer();
  vi.spyOn(p as unknown as { loadCurrent(): Promise<void> }, 'loadCurrent').mockResolvedValue();
  await p.playList([t('a'), t('b')], 0, mode === 'radio' ? radio('Home · Latest') : { label: 'Liked', mode: 'list' });
  await p.setRepeat(repeat);
  return p;
}
const ids = (p: WebPlayer) => p.state.peek().queue.map((x) => x.id);

describe('a radio under repeat all', () => {
  it('adds its first suggestions into its list, and no later ones', async () => {
    const p = await started('all');
    await p.addAutoplay([t('s1'), t('s2')], 'a');
    expect(ids(p)).toEqual(['a', 's1', 's2']);
    await p.addAutoplay([t('s3')], 'a');
    expect(ids(p)).toEqual(['a', 's1', 's2']);
    expect(firstBatchOfRadio({ label: 'x', mode: 'list' }, 1, 0)).toBe(false);
  });

  it('with repeat off, later batches are added too', async () => {
    const p = await started('off');
    await p.addAutoplay([t('s1')], 'a');
    await p.addAutoplay([t('s2')], 'a');
    expect(ids(p)).toEqual(['a', 's1', 's2']);
  });

  it('a song queued before the tap: the first batch still joins the list, with repeat all on before or after it', async () => {
    for (const before of [true, false]) {
      const p = await started('off', 'list');
      await p.addToQueue([t('Q')]);
      await p.playList([t('h')], 0, radio('Home · Latest'));
      if (before) await p.setRepeat('all');
      await p.addAutoplay([t('s1'), t('s2')], 'h');
      await p.setRepeat('all');
      expect(ids(p), `repeat all ${before ? 'before' : 'after'}`).toEqual(['h', 'Q', 's1', 's2']);
    }
  });

  it('a list gets nothing under repeat all', async () => {
    const p = await started('all', 'list');
    await p.addAutoplay([t('s1')], 'a');
    expect(ids(p)).toEqual(['a', 'b']);
  });
});

describe('the list you are in', () => {
  it('starts where the suggestions begin once you move on into them, and the next batch after', async () => {
    const p = await started('off', 'list');
    await p.addAutoplay([t('s1'), t('s2')], 'a');
    await p.next();
    await p.next();
    await p.setRepeat('off'); // the mocked load publishes nothing; this does
    expect(p.state.peek()).toMatchObject({ listStart: 2, nextStart: -1 });
    await p.addAutoplay([t('s3')], 'a');
    expect(p.state.peek()).toMatchObject({ listStart: 2, nextStart: 4 });
  });
});

describe('signing out', () => {
  it("taking the last song in play order while it plays: the first song is current, paused, as Media3's (S11); ✕ the same", async () => {
    for (const out of ['removeIds', 'remove'] as const) {
      const p = new WebPlayer();
      const inner = p as unknown as { loadCurrent(autoplay: boolean): Promise<void>; publish(s: { isPlaying: boolean }): void };
      vi.spyOn(inner, 'loadCurrent').mockImplementation(async (autoplay) => inner.publish({ isPlaying: autoplay }));
      await p.playList([t('a'), t('b'), t('c')], 2, { label: 'Liked', mode: 'list' });
      expect(p.state.peek().isPlaying).toBe(true);
      await (out === 'remove' ? p.remove(2, 'c') : p.removeIds(['c']));
      expect(p.state.peek().current?.id, out).toBe('a');
      expect(p.state.peek().isPlaying, out).toBe(false);
    }
  });
});
