import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false }, registerPlugin: () => ({}) }));
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {} } }));

const { createArtistChannels } = await import('./artistChannels');

const artist = (title: string, channelId: string) => ({ kind: 'artist' as const, title, subtitle: '', url: '', channelId });

describe('artist channel cache', () => {
  function setup(saved: Record<string, string> = {}) {
    const client = { artist: vi.fn(async () => [artist('Ivy Queen', 'UCivy'), artist('Queen', 'UCqueen')]) };
    const save = vi.fn();
    const s = createArtistChannels({ client, load: async () => saved, save });
    return { s, client, save };
  }

  it('resolves once and caches the exact match per normalized name', async () => {
    const { s, client, save } = setup();
    expect(await s.get('Queen')).toBe('UCqueen');
    expect(await s.get('QUEEN')).toBe('UCqueen');
    expect(client.artist).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith({ queen: 'UCqueen' });
  });

  it('uses saved channels and remembered ones without a lookup', async () => {
    const { s, client } = setup({ queen: 'UCsaved' });
    expect(await s.get('Queen')).toBe('UCsaved');
    s.remember('Tycho', 'UCtycho');
    await new Promise((r) => setTimeout(r, 0));
    expect(await s.get('tycho')).toBe('UCtycho');
    expect(client.artist).not.toHaveBeenCalled();
  });

  it('returns null and stores nothing without an exact match', async () => {
    const { s, save } = setup();
    expect(await s.get('Butterfly')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
});
