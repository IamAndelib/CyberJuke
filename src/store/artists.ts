/**
 * Artists for the Artists tab and artist pages: everyone credited on the Jukebox
 * (from the local catalog, NSFW setting applied), most-shared first.
 */
import { computed } from '@preact/signals';
import { artistKey, buildArtistIndex } from '../data/artists';
import type { Track } from '../data/model';
import { catalog } from './catalog';

export const artistIndex = computed(() => buildArtistIndex(catalog.tracks.value));

/** Every Jukebox track crediting `name`, newest first. */
export function jukeboxTracksBy(name: string): Track[] {
  return artistIndex.value.tracks.get(artistKey(name)) ?? [];
}

/** The display name the Jukebox uses for this artist, or `name` itself. */
export function displayArtist(name: string): string {
  return artistIndex.value.byKey.get(artistKey(name))?.name ?? name;
}
