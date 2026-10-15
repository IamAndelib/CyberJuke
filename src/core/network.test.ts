import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const status = { connected: true };
vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(() => Promise.resolve({ ...status })),
    addListener: vi.fn(() => Promise.resolve({ remove: () => {} })),
  },
}));

import { networkChanged, OFFLINE_GRACE_MS, online, onReconnect, recheckNetwork, watchNetwork } from './network';

describe('handover grace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    networkChanged(true);
  });
  afterEach(() => vi.useRealTimers());

  it('a loss counts only once it has lasted the grace', () => {
    networkChanged(false);
    vi.advanceTimersByTime(OFFLINE_GRACE_MS - 1);
    expect(online.value).toBe(true);
    vi.advanceTimersByTime(1);
    expect(online.value).toBe(false);
  });

  it('a blip shorter than the grace changes nothing, and the next loss waits a full grace again', () => {
    networkChanged(false);
    vi.advanceTimersByTime(OFFLINE_GRACE_MS - 100);
    networkChanged(true);
    vi.advanceTimersByTime(OFFLINE_GRACE_MS);
    expect(online.value).toBe(true);

    networkChanged(false);
    vi.advanceTimersByTime(OFFLINE_GRACE_MS - 1);
    expect(online.value).toBe(true);
    vi.advanceTimersByTime(1);
    expect(online.value).toBe(false);
  });

  it('repeated "not connected" reports keep the first deadline (one timer)', () => {
    networkChanged(false);
    vi.advanceTimersByTime(OFFLINE_GRACE_MS / 2);
    networkChanged(false);
    vi.advanceTimersByTime(OFFLINE_GRACE_MS / 2);
    expect(online.value).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coming back applies at once', () => {
    networkChanged(false);
    vi.advanceTimersByTime(OFFLINE_GRACE_MS);
    expect(online.value).toBe(false);
    networkChanged(true);
    expect(online.value).toBe(true);
  });

  it("Redial applies the OS's answer at once and drops a pending loss", async () => {
    status.connected = false;
    await recheckNetwork();
    expect(online.value).toBe(false);

    status.connected = true;
    networkChanged(true);
    networkChanged(false);
    await recheckNetwork();
    expect(online.value).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('reconnect callbacks', () => {
  const heard = vi.fn();
  let stop: () => void;
  beforeEach(async () => {
    vi.useFakeTimers();
    status.connected = true;
    watchNetwork();
    await vi.advanceTimersByTimeAsync(0); // the first status is in
    networkChanged(true);
    heard.mockClear();
    stop = onReconnect(heard);
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('run when the OS reports connected while the app is already online (a list that failed in a handover gap)', () => {
    networkChanged(true);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('run once, not twice, on offline → online', () => {
    networkChanged(false);
    vi.advanceTimersByTime(OFFLINE_GRACE_MS);
    expect(online.value).toBe(false);
    expect(heard).not.toHaveBeenCalled();
    networkChanged(true);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("run on Redial's connected answer, not on a disconnected one", async () => {
    await recheckNetwork();
    expect(heard).toHaveBeenCalledTimes(1);
    status.connected = false;
    await recheckNetwork();
    expect(heard).toHaveBeenCalledTimes(1);
    status.connected = true;
    await recheckNetwork();
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('do not run for a blip that ends within the grace with no report of a return', () => {
    networkChanged(false);
    vi.advanceTimersByTime(OFFLINE_GRACE_MS - 1);
    expect(heard).not.toHaveBeenCalled();
  });
});
