/**
 * The person's own playlists (docs/superpowers/specs/2026-11-03-playlists-design.md), kept in
 * `cyberjuke/playlists.json` like Liked: outside backups, since they can hold members-only songs.
 * Whole song records are stored, so a playlist plays without the catalog. A song is in a
 * playlist at most once.
 *
 * A members-only song keeps the account it was added under (`owners`): it shows only while
 * that account is signed in, and waits in the file otherwise, as liked ones wait in
 * members-kept. As Liked, NSFW songs hide with the setting, and local songs not on the phone now.
 */
import { computed, signal } from '@preact/signals';
import { isLocal, type Track } from '../data/model';
import { auth } from '../data/auth';
import { asTrack } from '../core/guards';
import { jsonFile, type JsonFile } from '../core/storage';
import { localHere, putBack, removedFrom, showNsfw, type Removed } from './library';

export interface Playlist {
  id: string;
  name: string;
  created: number;
  /** When a song was last added (the add sheet lists the most recent first). */
  updated: number;
  tracks: Track[];
  /** A members-only song's account, by track id. */
  owners?: Record<string, string>;
}

/** Most songs in one playlist, and most playlists: the file stays small. */
export const PLAYLIST_MAX_SONGS = 1000;
export const PLAYLISTS_MAX = 200;
export const PLAYLIST_NAME_MAX = 60;

export const playlists = signal<Playlist[]>([]);

const signedInAs = computed(() => (auth.state.value.status === 'signedIn' ? (auth.state.value.user?.uid ?? null) : null));

/** Whether [t] shows in [p] now (see the header). */
function visible(p: Playlist, t: Track, nsfw: boolean, here: ReadonlySet<string>, uid: string | null): boolean {
  if (t.nsfw && !nsfw) return false;
  if (isLocal(t) && !here.has(t.id)) return false;
  return !t.membersOnly || (uid != null && p.owners?.[t.id] === uid);
}

/** The playlists as they show, newest first, each with the songs that show now. */
export const playlistsShown = computed(() => {
  const nsfw = showNsfw.value;
  const here = localHere.value;
  const uid = signedInAs.value;
  return [...playlists.value].sort((a, b) => b.created - a.created).map((p) => ({ ...p, tracks: p.tracks.filter((t) => visible(p, t, nsfw, here, uid)) }));
});

export const playlistShown = (id: string) => playlistsShown.value.find((p) => p.id === id) ?? null;

/** A name as kept: trimmed, at most PLAYLIST_NAME_MAX characters; null when empty. */
export function cleanName(name: string): string | null {
  const n = name.replace(/\s+/g, ' ').trim().slice(0, PLAYLIST_NAME_MAX).trim();
  return n || null;
}

const VERSION = 1;

function parsePlaylist(x: unknown): Playlist | null {
  const o = x as Partial<Record<keyof Playlist, unknown>> | null;
  if (!o || typeof o.id !== 'string' || !o.id || typeof o.name !== 'string') return null;
  const name = cleanName(o.name);
  if (!name) return null;
  const seen = new Set<string>();
  const tracks: Track[] = [];
  for (const raw of Array.isArray(o.tracks) ? o.tracks : []) {
    const t = asTrack(raw);
    if (t && !seen.has(t.id) && tracks.length < PLAYLIST_MAX_SONGS) {
      seen.add(t.id);
      tracks.push(t);
    }
  }
  const owners: Record<string, string> = {};
  if (o.owners && typeof o.owners === 'object') for (const [k, v] of Object.entries(o.owners)) if (seen.has(k) && typeof v === 'string') owners[k] = v;
  const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { id: o.id, name, created: time(o.created), updated: time(o.updated), tracks, ...(Object.keys(owners).length && { owners }) };
}

/** The file's playlists; anything but this version's file reads as none. */
function parsePlaylists(raw: unknown): Playlist[] | null {
  const o = raw as { version?: unknown; playlists?: unknown } | null;
  if (!o || o.version !== VERSION || !Array.isArray(o.playlists)) return null;
  const ids = new Set<string>();
  const out: Playlist[] = [];
  for (const x of o.playlists) {
    const p = parsePlaylist(x);
    if (p && !ids.has(p.id) && out.length < PLAYLISTS_MAX) {
      ids.add(p.id);
      out.push(p);
    }
  }
  return out;
}

let file: JsonFile<unknown> = jsonFile('data', 'playlists', (raw) => raw);
let loaded = false;

/** Tests: another file. */
export function setPlaylistsFile(f: JsonFile<unknown>): void {
  file = f;
  loaded = false;
  playlists.value = [];
}

/** Reads the file once; a playlist made before it was read is kept. */
export async function loadPlaylists(): Promise<void> {
  const read = parsePlaylists(await file.load().catch(() => null));
  const before = playlists.peek();
  playlists.value = [...(read ?? []).filter((p) => !before.some((b) => b.id === p.id)), ...before];
  loaded = true;
  if (before.length) save();
}

function save(): void {
  if (loaded) void file.save({ version: VERSION, playlists: playlists.peek() });
}

function update(id: string, change: (p: Playlist) => Playlist): void {
  playlists.value = playlists.peek().map((p) => (p.id === id ? change(p) : p));
  save();
}

const find = (id: string) => playlists.peek().find((p) => p.id === id) ?? null;

/** The account a members-only song is added under (none for any other song). */
function ownersWith(p: Playlist | null, t: Track): Record<string, string> | undefined {
  const uid = signedInAs.peek();
  if (!t.membersOnly || !uid) return p?.owners;
  return { ...p?.owners, [t.id]: uid };
}

let seq = 0;
const newId = () => `pl${Date.now().toString(36)}${(seq++).toString(36)}`;

export type CreateResult = { result: 'created'; id: string } | { result: 'full' } | { result: 'unnamed' };

/** A new playlist named [name], holding [tracks] (each once, up to the limit). */
export function createPlaylist(name: string, tracks: readonly Track[] = [], now = Date.now()): CreateResult {
  const n = cleanName(name);
  if (!n) return { result: 'unnamed' };
  if (playlists.peek().length >= PLAYLISTS_MAX) return { result: 'full' };
  const p: Playlist = { id: newId(), name: n, created: now, updated: now, tracks: [] };
  for (const t of tracks) {
    if (p.tracks.length >= PLAYLIST_MAX_SONGS) break;
    if (p.tracks.some((x) => x.id === t.id)) continue;
    p.tracks.push(t);
    const owners = ownersWith(p, t);
    if (owners) p.owners = owners;
  }
  playlists.value = [...playlists.peek(), p];
  save();
  return { result: 'created', id: p.id };
}

/** Whether playlist [id] has song [trackId] (shown or not). */
export const playlistHas = (id: string, trackId: string): boolean => !!find(id)?.tracks.some((t) => t.id === trackId);

/** Adds [track] at the end of playlist [id]. */
export function addToPlaylist(id: string, track: Track, now = Date.now()): 'added' | 'already' | 'full' | 'gone' {
  const p = find(id);
  if (!p) return 'gone';
  if (p.tracks.some((t) => t.id === track.id)) return 'already';
  if (p.tracks.length >= PLAYLIST_MAX_SONGS) return 'full';
  const owners = ownersWith(p, track);
  update(id, (x) => ({ ...x, tracks: [...x.tracks, track], updated: now, ...(owners && { owners }) }));
  return 'added';
}

/** Takes song [trackId] out of playlist [id]; returns what Undo needs. */
export function removeFromPlaylist(id: string, trackId: string): Removed<Track> | null {
  const p = find(id);
  const i = p ? p.tracks.findIndex((t) => t.id === trackId) : -1;
  if (!p || i < 0) return null;
  const r = removedFrom(p.tracks, i, (t) => t.id);
  update(id, (x) => ({ ...x, tracks: x.tracks.filter((t) => t.id !== trackId) }));
  return r;
}

/** Undo of a removal: the song goes back where it was (the playlist must still be there). */
export function restoreToPlaylist(id: string, r: Removed<Track>): void {
  const p = find(id);
  if (!p || p.tracks.some((t) => t.id === r.item.id)) return;
  update(id, (x) => ({ ...x, tracks: putBack(x.tracks, r, (t) => t.id) }));
}

/** Moves song [trackId] one place up (-1) or down (+1) among the songs that show. */
export function moveInPlaylist(id: string, trackId: string, delta: -1 | 1): void {
  const shown = playlistShown(id)?.tracks ?? [];
  const at = shown.findIndex((t) => t.id === trackId);
  const other = shown[at + delta];
  if (at < 0 || !other) return;
  update(id, (x) => {
    const tracks = [...x.tracks];
    const a = tracks.findIndex((t) => t.id === trackId);
    const b = tracks.findIndex((t) => t.id === other.id);
    [tracks[a], tracks[b]] = [tracks[b]!, tracks[a]!];
    return { ...x, tracks };
  });
}

/** Renames playlist [id]; false (and no change) for an empty name. */
export function renamePlaylist(id: string, name: string): boolean {
  const n = cleanName(name);
  if (!n || !find(id)) return false;
  update(id, (x) => ({ ...x, name: n }));
  return true;
}

export function deletePlaylist(id: string): void {
  if (!find(id)) return;
  playlists.value = playlists.peek().filter((p) => p.id !== id);
  save();
}
