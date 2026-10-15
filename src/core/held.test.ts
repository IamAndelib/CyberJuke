import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@preact/signals';
import { heldFor } from './held';

describe('heldFor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the state only once it has held for the delay, and hides it at once', () => {
    const source = signal(false);
    const held = heldFor(source, 1000);
    source.value = true;
    expect(held.value).toBe(false);
    vi.advanceTimersByTime(999);
    expect(held.value).toBe(false);
    vi.advanceTimersByTime(1);
    expect(held.value).toBe(true);
    source.value = false;
    expect(held.value).toBe(false);
  });

  it('a blip shorter than the delay is never shown', () => {
    const source = signal(false);
    const held = heldFor(source, 1000);
    source.value = true;
    vi.advanceTimersByTime(300);
    source.value = false;
    vi.advanceTimersByTime(2000);
    expect(held.value).toBe(false);
    // The next rise starts its own wait.
    source.value = true;
    vi.advanceTimersByTime(999);
    expect(held.value).toBe(false);
    vi.advanceTimersByTime(1);
    expect(held.value).toBe(true);
  });
});
