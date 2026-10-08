/**
 * Artist name -> channel id, so "More by" and the albums shelf list exactly this
 * artist. Resolved once with the plugin's artist() search and kept in Preferences.
 * Only exact matches are stored; a name with no exact match is retried next session.
 */
import { Preferences } from '@capacitor/preferences';
import { Cache } from '../core/cache';
import { artistKey } from '../data/artists';
import { music, resolveArtistChannel, type MusicClient } from '../data/ytmusic';

const K_CHANNELS = 'artistChannels';
/** Most names kept (oldest dropped first). */
export const ARTIST_CHANNELS_MAX = 500;

export interface ArtistChannelStore {
  get(name: string): Promise<string | null>;
  remember(name: string, channelId: string | undefined): void;
}

export interface ArtistChannelDeps {
  client: Pick<MusicClient, 'artist'>;
  load(): Promise<Record<string, string>>;
  save(map: Record<string, string>): void;
}

export function createArtistChannels(deps: ArtistChannelDeps): ArtistChannelStore {
  /** No expiry; past ARTIST_CHANNELS_MAX the least recently stored name goes. */
  let map: Cache<string, string> | null = null;
  let loading: Promise<Cache<string, string>> | null = null;
  const ready = () =>
    map
      ? Promise.resolve(map)
      : (loading ??= deps
          .load()
          .catch(() => ({}))
          .then((o) => {
            const c = new Cache<string, string>({ max: ARTIST_CHANNELS_MAX });
            for (const [k, v] of Object.entries(o ?? {})) if (typeof v === 'string') c.restore(k, v, 0);
            return (map = c);
          }));
  const put = (key: string, id: string) => {
    if (!map) return;
    map.set(key, id);
    deps.save(Object.fromEntries(map.pairs()));
  };
  return {
    async get(name) {
      const key = artistKey(name);
      if (!key) return null;
      const m = await ready();
      const hit = m.get(key);
      if (hit) return hit;
      const id = resolveArtistChannel(await deps.client.artist(name), name);
      if (id) put(key, id);
      return id;
    },
    remember(name, channelId) {
      const key = artistKey(name);
      if (!key || !channelId) return;
      void ready().then(() => put(key, channelId));
    },
  };
}

export const artistChannels = createArtistChannels({
  client: music,
  load: async () => {
    const { value } = await Preferences.get({ key: K_CHANNELS });
    return value ? (JSON.parse(value) as Record<string, string>) : {};
  },
  save: (map) => void Preferences.set({ key: K_CHANNELS, value: JSON.stringify(map) }).catch(() => {}),
});
