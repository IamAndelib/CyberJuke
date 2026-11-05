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
    expect(firstBatchOfRadio({ label: 'x', mode: 'list' }, 1)).toBe(false);
  });

  it('with repeat off, later batches are added too', async () => {
    const p = await started('off');
    await p.addAutoplay([t('s1')], 'a');
    await p.addAutoplay([t('s2')], 'a');
    expect(ids(p)).toEqual(['a', 's1', 's2']);
  });

  it('a list gets nothing under repeat all', async () => {
    const p = await started('all', 'list');
    await p.addAutoplay([t('s1')], 'a');
    expect(ids(p)).toEqual(['a', 'b']);
  });
});
