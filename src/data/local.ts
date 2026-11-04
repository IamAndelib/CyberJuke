/**
 * Local music: the `JukeLocal` plugin (android/.../bridge/LocalPlugin.kt), which reads only the
 * folders the person chose with Android's folder picker. The contract is documented there; this
 * side parses every answer (core/guards) and never handles a file's location, only song ids.
 * In the browser build there is no local music unless a test installs a fake as
 * `window.__cyberjukeLocalStub`.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { TEST_HOOKS } from '../core/testHooks';
import { parseLocalFolders, parseLocalSongs } from '../core/guards';
import { makeTrack, type Track } from './model';

export type LocalFolderState = 'ok' | 'scanning' | 'gone';

export interface LocalFolder {
  /** Opaque: only ever passed back to the plugin. */
  id: string;
  name: string;
  songs: number;
  state: LocalFolderState;
}

export interface LocalSong {
  /** `loc:` + 16 hex. */
  id: string;
  title: string;
  artist: string;
  album: string;
  /** The album artist tag as it is ('' for none). */
  albumArtist: string;
  /** Track and disc numbers and the year: 0 when unknown. */
  track: number;
  disc: number;
  year: number;
  durationMs: number;
  /** When the file last changed (came to the phone, usually), in ms: 0 when unknown. */
  modified: number;
  /** The folder's id. */
  folder: string;
  /** A cover is kept on the phone (`/_local/art/<hex>.jpg`). */
  cover: boolean;
}

type AddFolderResult = { result: 'added'; folder: LocalFolder } | { result: 'inside'; name: string } | { result: 'cancelled' };

interface LocalChanged {
  scanning: string | null;
  found: number;
  done: boolean;
}

export interface JukeLocalPlugin {
  folders(): Promise<unknown>;
  addFolder(o?: { initial?: string }): Promise<unknown>;
  removeFolder(o: { id: string }): Promise<void>;
  tracks(): Promise<unknown>;
  scan(): Promise<void>;
  setEnabled(o: { on: boolean }): Promise<void>;
  addListener(event: 'localChanged', cb: (e: unknown) => void): Promise<PluginListenerHandle>;
}

declare global {
  interface Window {
    /** e2e only: a fake JukeLocal used in the browser build. */
    __cyberjukeLocalStub?: JukeLocalPlugin;
  }
}

const JukeLocal = registerPlugin<JukeLocalPlugin>('JukeLocal');

function plugin(): JukeLocalPlugin | null {
  if (TEST_HOOKS && typeof window !== 'undefined' && window.__cyberjukeLocalStub) return window.__cyberjukeLocalStub;
  return Capacitor.isNativePlatform() ? JukeLocal : null;
}

/** Whether this build can play local music at all (the app on a phone, or a test's fake). */
export const localAvailable = (): boolean => plugin() !== null;

/** Where a local song's cover is served on the page's own origin (ArtWebViewClient), when it has one. */
export const localArtUrl = (id: string): string => `/_local/art/${id.slice(4)}.jpg`;

/** A local song as a Track: no video id or link, its album, its cover from the phone when it has one. */
export function songToTrack(s: LocalSong): Track {
  return makeTrack({
    id: s.id,
    ytId: '',
    title: s.title,
    artist: s.artist,
    ...(s.album && { album: s.album }),
    artworkUrl: s.cover ? localArtUrl(s.id) : '',
    source: 'local',
  });
}

/** In the browser build (tests), where a local song's audio is served from (the fake's route). */
export const localAudioUrl = (id: string): string => `/_local/audio/${id.slice(4)}.mp3`;

export async function localFolders(): Promise<LocalFolder[]> {
  const p = plugin();
  return p ? parseLocalFolders(await p.folders()) : [];
}

export async function addLocalFolder(initial?: string): Promise<AddFolderResult> {
  const p = plugin();
  if (!p) return { result: 'cancelled' };
  const r = (await p.addFolder(initial ? { initial } : {})) as Record<string, unknown> | null;
  if (r?.result === 'added') {
    const [folder] = parseLocalFolders({ folders: [r.folder] });
    if (folder) return { result: 'added', folder };
  }
  if (r?.result === 'inside' && typeof r.name === 'string') return { result: 'inside', name: r.name };
  return { result: 'cancelled' };
}

export async function removeLocalFolder(id: string): Promise<void> {
  await plugin()?.removeFolder({ id });
}

export async function localSongs(): Promise<LocalSong[]> {
  const p = plugin();
  return p ? parseLocalSongs(await p.tracks()) : [];
}

export async function scanLocal(): Promise<void> {
  await plugin()?.scan();
}

/** Turning local music off: every folder's access given back, the list and covers deleted. */
export async function disableLocal(): Promise<void> {
  await plugin()?.setEnabled({ on: false });
}

/** Scan progress and ends; a no-op where there is no local music. */
export async function onLocalChanged(cb: (e: LocalChanged) => void): Promise<() => void> {
  const p = plugin();
  if (!p) return () => undefined;
  const h = await p.addListener('localChanged', (e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    cb({
      scanning: typeof o.scanning === 'string' ? o.scanning : null,
      found: typeof o.found === 'number' && Number.isFinite(o.found) ? Math.max(0, o.found) : 0,
      done: o.done === true,
    });
  });
  return () => void h.remove();
}
