/**
 * Signal Radio: hyphen8d's curated stations for Cyberspace's Jukebox (bundled from
 * hyphen8d/signal by scripts/update-stations.mjs), and how a station plays. As on
 * cyberspace.online, a station is a shuffle of all its tracks, then another shuffle, and so on;
 * a new round never starts with the track the last one ended on.
 *
 * Station tracks are ordinary Tracks with no post: id `sig:<station id>:<video id>`, the
 * callsign as genre, source 'signal'. Pure apart from the bundled data.
 */
import data from '../data/radio/stations.json';
import { artworkUrl, makeTrack, type Track } from '../data/model';

export type Band = 'ym' | 'zm';

export interface Station {
  /** The upstream slug ("cipher"). */
  id: string;
  band: Band;
  /** Where it sits on the dial (133.7). */
  freq: number;
  callsign: string;
  tagline: string;
  desc: string;
  tracks: readonly { ytId: string; title: string; artist: string }[];
}

/** Every station, by band then frequency. */
export const STATIONS: readonly Station[] = data.stations as Station[];

export const BAND_NAMES: Record<Band, string> = { ym: 'YM band', zm: 'ZM band' };

const PREFIX = 'sig:';

/** What Now Playing shows as the source of a station: "Signal Radio · CIPHER". */
export const stationLabel = (s: Pick<Station, 'callsign'>): string => `Signal Radio · ${s.callsign}`;

/** The dial reading, as the site shows it: one decimal ("273.0"). */
export const stationFreq = (s: Pick<Station, 'freq'>): string => s.freq.toFixed(1);

export function stationById(id: string): Station | null {
  return STATIONS.find((s) => s.id === id) ?? null;
}

/**
 * A station's track id. A station plays on round after round whatever the Autoplay setting:
 * it isn't autoplay, it is the station (natively QueueCommands.STATION_PREFIX, the same rule).
 */
export const isStationId = (id: string | null | undefined): boolean => !!id?.startsWith(PREFIX);

/** The station a track id belongs to (`sig:<station>:<video id>`), or null. */
export function stationOfTrackId(id: string | null | undefined): Station | null {
  if (!id?.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const at = rest.lastIndexOf(':');
  return at > 0 ? stationById(rest.slice(0, at)) : null;
}

const built = new Map<string, readonly Track[]>();

/** A station's tracks as Tracks, in the curated order (the same objects every call). */
export function stationTracks(s: Station): readonly Track[] {
  let out = built.get(s.id);
  if (!out) {
    out = s.tracks.map((t) =>
      makeTrack({ id: `${PREFIX}${s.id}:${t.ytId}`, ytId: t.ytId, title: t.title, artist: t.artist, genre: s.callsign, artworkUrl: artworkUrl(t.ytId), source: 'signal' }),
    );
    built.set(s.id, out);
  }
  return out;
}

/** The station track with this id, or null (not a station track, or no longer on its station). */
export function stationTrack(id: string): Track | null {
  const s = stationOfTrackId(id);
  return s ? (stationTracks(s).find((t) => t.id === id) ?? null) : null;
}

/** Fisher-Yates, as the site does it. */
function shuffle<T>(xs: readonly T[], rng: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * One round of a station: all its tracks, shuffled. After `lastYtId` (the last track queued),
 * the round doesn't start with that same track: it goes to the end instead.
 */
export function stationQueue(s: Station, lastYtId?: string | null, rng: () => number = Math.random): Track[] {
  const round = shuffle(stationTracks(s), rng);
  if (lastYtId && round.length > 1 && round[0].ytId === lastYtId) round.push(round.shift()!);
  return round;
}
