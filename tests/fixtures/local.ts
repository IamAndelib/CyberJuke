/**
 * A fake JukeLocal (src/data/local.ts) for the test build: chosen folders with their songs,
 * Android's folder picker played by a list of picks, looks through the folders with their
 * progress events, and the covers and audio the app serves on its own origin on a phone
 * (`/_local/art/<hex>.jpg`, and for the browser player `/_local/audio/<hex>.mp3`, silence).
 * State survives a reload (localStorage), as the phone's index does.
 */
import type { Page } from '@playwright/test';
import { silentMp3 } from './latex';

export interface FakeLocalSong {
  /** 16 hex: the song's id is `loc:` + this. */
  hex: string;
  title: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  track?: number;
  disc?: number;
  year?: number;
  cover?: boolean;
  /** The file's last change, in ms (default: by hex, so a later song is a newer file). */
  modified?: number;
}

export interface FakeLocalFolder {
  /** The folder's id (the tree URI on a phone). */
  id: string;
  name: string;
  songs: FakeLocalSong[];
  /** Can't be reached (card out, access gone). */
  gone?: boolean;
}

/** What the picker gives, in order: a folder, one inside a chosen one (by its name), or backing out. */
export type FakePick = FakeLocalFolder | { inside: string } | 'cancel';

export interface LocalStubOptions {
  /** Folders already chosen (local music must be on in the settings too). */
  folders?: FakeLocalFolder[];
  picks?: FakePick[];
  /** How long each folder's look takes, ms. */
  scanMs?: number;
}

const hex = (n: number) => n.toString(16).padStart(16, '0');

/**
 * A folder "Music" of [n] songs, the last untagged: the others alternate between Ana Tape's
 * album "Attic" (2001, with covers) and Zed Loop's "Basement" (2009), numbered so an album's
 * order isn't its titles' (track n - i).
 */
export function musicFolder(n = 6, id = 'tree:music', name = 'Music'): FakeLocalFolder {
  const base = id === 'tree:music' ? 0 : 0x100;
  return {
    id,
    name,
    songs: Array.from({ length: n }, (_, i) => {
      if (i >= n - 1) return { hex: hex(base + i + 1), title: `voice memo ${i + 1}` };
      const ana = i % 2 === 0;
      return {
        hex: hex(base + i + 1),
        title: `${name} song ${String.fromCharCode(65 + ((i * 3) % 26))}`,
        artist: ana ? 'Ana Tape' : 'Zed Loop',
        album: ana ? 'Attic' : 'Basement',
        year: ana ? 2001 : 2009,
        track: n - i,
        cover: ana,
      };
    }),
  };
}

function fakeCover(hexId: string): string {
  const hue = parseInt(hexId.slice(-3), 16) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="hsl(${hue} 50% 35%)"/><circle cx="32" cy="32" r="20" fill="hsl(${(hue + 150) % 360} 70% 70%)"/></svg>`;
}

const MP3 = silentMp3(4);

export async function stubLocal(page: Page, o: LocalStubOptions): Promise<void> {
  await page.route(/\/_local\/art\/[0-9a-f]{16}\.jpg$/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: fakeCover(route.request().url().slice(-20, -4)) }));
  await page.route(/\/_local\/audio\/[0-9a-f]{16}\.mp3$/, (route) =>
    route.fulfill({ status: 200, contentType: 'audio/mpeg', headers: { 'accept-ranges': 'bytes' }, body: MP3 }),
  );
  await page.addInitScript(
    ({ init }) => {
      type Song = { hex: string; title: string; artist?: string; album?: string; albumArtist?: string; track?: number; disc?: number; year?: number; cover?: boolean; modified?: number };
      type Folder = { id: string; name: string; songs: Song[]; gone?: boolean };
      type Pick = Folder | { inside: string } | 'cancel';
      type State = { folders: Folder[]; picks: Pick[]; added: string[]; removed: string[]; disabled: number };
      const KEY = '__cyberjukeLocalFake';
      const saved = localStorage.getItem(KEY);
      const st: State = saved ? JSON.parse(saved) : { folders: init.folders ?? [], picks: init.picks ?? [], added: [], removed: [], disabled: 0 };
      const save = () => localStorage.setItem(KEY, JSON.stringify(st));
      save();
      const listeners: ((e: unknown) => void)[] = [];
      let scanning: string | null = null;
      const emit = (found: number, done: boolean) => listeners.forEach((l) => l({ scanning, found, done }));
      const folderJson = (f: Folder) => ({ id: f.id, name: f.name, songs: f.songs.length, state: f.id === scanning ? 'scanning' : f.gone ? 'gone' : 'ok' });
      let queue: Promise<void> = Promise.resolve();
      const look = (ids: string[] | null) => {
        queue = queue.then(async () => {
          for (const f of st.folders.filter((x) => !ids || ids.includes(x.id))) {
            scanning = f.id;
            emit(0, false);
            await new Promise((r) => setTimeout(r, init.scanMs ?? 50));
            emit(f.gone ? 0 : f.songs.length, false);
            await new Promise((r) => setTimeout(r, init.scanMs ?? 50));
          }
          scanning = null;
          emit(0, true);
        });
      };
      const w = window as unknown as Record<string, unknown>;
      // Tests: what the fake was asked, and more picks for the picker.
      w.__localFake = st;
      w.__localPick = (p: Pick) => {
        st.picks.push(p);
        save();
      };
      w.__localSetGone = (id: string, gone: boolean) => {
        const f = st.folders.find((x) => x.id === id);
        if (f) f.gone = gone;
        save();
      };
      w.__cyberjukeLocalStub = {
        folders: async () => ({ folders: st.folders.map(folderJson) }),
        addFolder: async () => {
          const p = st.picks.shift();
          save();
          if (!p || p === 'cancel') return { result: 'cancelled' };
          if ('inside' in p) return { result: 'inside', name: p.inside };
          const known = st.folders.find((f) => f.id === p.id);
          if (known) known.gone = false;
          else st.folders.push(p);
          st.added.push(p.id);
          save();
          look([p.id]);
          return { result: 'added', folder: folderJson(known ?? p) };
        },
        removeFolder: async ({ id }: { id: string }) => {
          st.folders = st.folders.filter((f) => f.id !== id);
          st.removed.push(id);
          save();
        },
        tracks: async () => ({
          tracks: st.folders.flatMap((f) =>
            f.songs.map((s) => ({
              id: `loc:${s.hex}`,
              title: s.title,
              artist: s.artist ?? 'Unknown artist',
              album: s.album ?? '',
              albumArtist: s.albumArtist ?? '',
              track: s.track ?? 0,
              disc: s.disc ?? 0,
              year: s.year ?? 0,
              durationMs: 4000,
              modified: s.modified ?? parseInt(s.hex, 16) * 1000,
              folder: f.id,
              cover: !!s.cover,
            })),
          ),
        }),
        scan: async () => look(null),
        setEnabled: async ({ on }: { on: boolean }) => {
          if (on) return;
          st.folders = [];
          st.disabled++;
          save();
        },
        addListener: async (_e: string, cb: (e: unknown) => void) => {
          listeners.push(cb);
          return { remove: async () => void listeners.splice(listeners.indexOf(cb), 1) };
        },
      };
    },
    { init: o },
  );
}
