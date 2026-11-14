/**
 * Signal Radio: hyphen8d's curated SIGNAL stations, which Cyberspace's Jukebox plays since 4.0
 * (bundled from hyphen8d/signal by scripts/update-stations.mjs), and how a station plays: its
 * tracks as a list, then the next station (nextStation), as on a radio dial or with Poweramp's
 * "Advance Category".
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

/** How a station's list is labelled: what the Radio tab starts it with, nothing else can (natively Stations.LABEL). */
const STATION_LABEL = 'Signal Radio · ';

/** What Now Playing shows as the source of a station: "Signal Radio · CIPHER". */
export const stationLabel = (s: Pick<Station, 'callsign'>): string => `${STATION_LABEL}${s.callsign}`;

/** The dial reading, as the site shows it: one decimal ("273.0"). */
export const stationFreq = (s: Pick<Station, 'freq'>): string => s.freq.toFixed(1);

export function stationById(id: string): Station | null {
  return STATIONS.find((s) => s.id === id) ?? null;
}

/**
 * Stations playing: a list the Radio tab started (its label) whose seed is a station track, of the
 * station tuned in or, once the chain has moved on, another's; returns the seed's station. They
 * lead on whatever the Autoplay setting: it isn't autoplay, it is the radio (natively
 * Stations.keepsGoing, the same rule). A station's track in any other list (Liked, Recently
 * played) is just a track there.
 */
export function stationPlaying(context: { label: string } | null | undefined, seedId: string | null | undefined): Station | null {
  return context?.label.startsWith(STATION_LABEL) ? stationOfTrackId(seedId) : null;
}

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

/**
 * The station after `current`: shuffle off, the next in the Radio tab's order (YM, then ZM, by
 * frequency), the first again after the last; shuffle on, a random one not `heard` yet in this chain,
 * any but `current` once all have been. Only stations `ok` takes (offline: one with a saved song);
 * null if none.
 */
export function nextStation(current: Station, shuffle: boolean, heard: readonly string[], ok: (s: Station) => boolean = () => true, rng: () => number = Math.random): Station | null {
  const at = STATIONS.indexOf(current);
  const after = [...STATIONS.slice(at + 1), ...STATIONS.slice(0, at)].filter(ok);
  if (!shuffle) return after[0] ?? null;
  const fresh = after.filter((s) => !heard.includes(s.id));
  const from = fresh.length ? fresh : after;
  return from.length ? from[Math.floor(rng() * from.length)] : null;
}
