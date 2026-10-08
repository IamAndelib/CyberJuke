import { describe, expect, it } from 'vitest';
import { PULL_MAX, PULL_REFRESH_AT, PULL_SLOP, pullIntent, rubberBand } from './pullToRefresh';

describe('rubberBand', () => {
  it('starts at 0 and never passes PULL_MAX', () => {
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(-40)).toBe(0);
    expect(rubberBand(1e6)).toBeLessThan(PULL_MAX);
    expect(rubberBand(1e6)).toBeGreaterThan(PULL_MAX - 1);
  });
  it('resists more the further it goes', () => {
    const steps = [0, 50, 100, 150, 200, 250].map(rubberBand);
    const gains = steps.slice(1).map((v, i) => v - steps[i]);
    for (let i = 1; i < gains.length; i++) expect(gains[i]).toBeLessThan(gains[i - 1]);
  });
  it('reaches the refresh distance after a deliberate pull, not a nudge', () => {
    expect(rubberBand(80)).toBeLessThan(PULL_REFRESH_AT);
    expect(rubberBand(180)).toBeGreaterThanOrEqual(PULL_REFRESH_AT);
  });
});

describe('pullIntent', () => {
  it('waits inside the slop', () => {
    expect(pullIntent(PULL_SLOP - 1, PULL_SLOP - 1)).toBe('wait');
  });
  it('pulls when mostly downward', () => {
    expect(pullIntent(3, 20)).toBe('pull');
    expect(pullIntent(-15, 16)).toBe('pull');
  });
  it('leaves sideways swipes (the genre chips) and upward moves alone', () => {
    expect(pullIntent(30, 12)).toBe('other');
    expect(pullIntent(-30, 12)).toBe('other');
    expect(pullIntent(0, -20)).toBe('other');
  });
});
