/**
 * Storage for the app, in one place.
 *
 * - `kv`: small keys (settings, likes, favorites, sort orders) in Capacitor
 *   Preferences (SharedPreferences on Android, localStorage in the browser).
 * - Files: larger JSON (the catalog, history, the lyrics cache) through
 *   @capacitor/filesystem: `cyberjuke/<name>.json` in Directory.Data, or
 *   `cyberjuke-cache/<name>.json` in Directory.Cache. In the browser they fall back
 *   to localStorage (`cyberjuke.file:<path>`).
 *
 * A file write is skipped when the text is the same as what was last read or
 * written. Reads, writes and removes of one file run one at a time, in call order
 * (of writes queued meanwhile, the latest wins), so a remove can't be undone by a
 * write still going. A native write goes to `<path>.tmp` first and is renamed over
 * the file, so a crash can't leave half a catalog behind. A file that is there but
 * can't be read isn't overwritten until a read works again.
 *
 * Migration: a file made from data that used to live in Preferences names its old
 * keys. When the file doesn't exist yet, the first old key found is copied into it
 * and, once that write has succeeded, every old key is removed. Readers accept the
 * old shapes, so the next save rewrites the file in the new one.
 */
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { logError } from './log';

export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Capacitor Preferences. */
export const kv: KV = {
  get: async (key) => (await Preferences.get({ key })).value,
  set: async (key, value) => {
    await Preferences.set({ key, value });
  },
  remove: async (key) => {
    await Preferences.remove({ key });
  },
};

/** Read a JSON value from a small key; `fallback` when missing or unreadable. */
export async function readJson<T>(store: KV, key: string, fallback: T): Promise<T> {
  try {
    const value = await store.get(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

type Area = 'data' | 'cache';
const AREA_DIRS: Record<Area, string> = { data: 'cyberjuke', cache: 'cyberjuke-cache' };

export function filePath(area: Area, name: string): string {
  return `${AREA_DIRS[area]}/${name}.json`;
}

/** Where file text lives: the device filesystem, or localStorage in the browser. */
export interface FileBackend {
  /** The file's text, or null when there is none. Rejects when it exists but can't be read. */
  read(area: Area, path: string): Promise<string | null>;
  write(area: Area, path: string, text: string): Promise<void>;
  remove(area: Area, path: string): Promise<void>;
}

/** The plugin's "does not exist" error (OS-PLUG-FILE-0008), as opposed to a failed read. */
export function isMissingFile(e: unknown): boolean {
  const o = (e ?? {}) as { code?: unknown; message?: unknown };
  if (o.code === 'OS-PLUG-FILE-0008') return true;
  return typeof o.message === 'string' && /does not exist|no such file|ENOENT/i.test(o.message);
}

/** @capacitor/filesystem, Directory.Data / Directory.Cache. */
function nativeFiles(): FileBackend {
  const fs = () => import('@capacitor/filesystem');
  const dir = async (area: Area) => {
    const { Directory } = await fs();
    return area === 'data' ? Directory.Data : Directory.Cache;
  };
  return {
    async read(area, path) {
      const { Filesystem, Encoding } = await fs();
      try {
        const r = await Filesystem.readFile({ path, directory: await dir(area), encoding: Encoding.UTF8 });
        return typeof r.data === 'string' ? r.data : await r.data.text();
      } catch (e) {
        if (isMissingFile(e)) return null;
        throw e; // there, but unreadable right now: the caller mustn't take it for empty
      }
    },
    async write(area, path, text) {
      const { Filesystem, Encoding } = await fs();
      const directory = await dir(area);
      const tmp = path + '.tmp';
      await Filesystem.writeFile({ path: tmp, data: text, directory, encoding: Encoding.UTF8, recursive: true });
      try {
        await Filesystem.rename({ from: tmp, to: path, directory });
      } catch {
        await Filesystem.writeFile({ path, data: text, directory, encoding: Encoding.UTF8, recursive: true });
        await Filesystem.deleteFile({ path: tmp, directory }).catch(() => {});
      }
    },
    async remove(area, path) {
      const { Filesystem } = await fs();
      await Filesystem.deleteFile({ path, directory: await dir(area) }).catch(() => {});
    },
  };
}

export const LOCAL_FILE_PREFIX = 'cyberjuke.file:';

/** localStorage, for the browser build (dev, e2e). */
export function localFiles(ls: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage): FileBackend {
  const k = (area: Area, path: string) => `${LOCAL_FILE_PREFIX}${area}/${path}`;
  return {
    read: async (area, path) => ls.getItem(k(area, path)),
    write: async (area, path, text) => ls.setItem(k(area, path), text),
    remove: async (area, path) => ls.removeItem(k(area, path)),
  };
}

let defaultBackend: FileBackend | null = null;
function files(): FileBackend {
  return (defaultBackend ??= Capacitor.isNativePlatform() ? nativeFiles() : localFiles());
}

interface TextFileOptions {
  backend?: FileBackend;
  /** Preferences keys this file replaces (newest shape first). */
  legacyKeys?: readonly string[];
  kv?: KV;
}

export interface TextFile {
  readonly path: string;
  /**
   * The text (migrating old keys on first use), or null when there is none. Never
   * rejects: a read that fails (the file is there but can't be read) returns null and
   * sets `unreadable`.
   */
  read(): Promise<string | null>;
  /**
   * Write unless it's what the file already holds. Never rejects (failures are logged).
   * Skipped while `unreadable`: a file we couldn't read isn't replaced by what we have
   * without it. A later read() that works lifts that.
   */
  write(text: string): Promise<void>;
  /** Delete the file, after any write still going (it can't come back). */
  remove(): Promise<void>;
  /** The last read failed for a reason other than a missing file. */
  readonly unreadable: boolean;
}

export function textFile(area: Area, name: string, opts: TextFileOptions = {}): TextFile {
  const path = filePath(area, name);
  const backend = () => opts.backend ?? files();
  const store = opts.kv ?? kv;
  const legacy = opts.legacyKeys ?? [];
  /** What the file holds, as far as we know (undefined: unknown). */
  let last: string | null | undefined;
  let pending: string | null = null;
  let writing: Promise<void> | null = null;
  let unreadable = false;
  /** Bumped by remove(): a write loop from before it stops. */
  let gen = 0;
  /** Every write, remove and read of the file, in call order: none of them overlap. */
  let chain: Promise<unknown> = Promise.resolve();
  const queue = <T>(job: () => Promise<T>): Promise<T> => {
    const p = chain.then(job);
    chain = p.catch(() => {});
    return p;
  };

  async function drain(g: number): Promise<void> {
    while (pending != null && g === gen) {
      const text = pending;
      pending = null;
      try {
        await backend().write(area, path, text);
      } catch (e) {
        logError(`storage.write ${path}`, e);
        if (last === text) last = undefined; // retry next time, even with the same text
      }
    }
    if (g === gen) writing = null;
  }

  async function dropLegacy(): Promise<void> {
    for (const key of legacy) await store.remove(key).catch(() => {});
  }

  return {
    path,
    get unreadable() {
      return unreadable;
    },
    read() {
      // After the writes already asked for, so it sees what they wrote.
      return queue(async () => {
        let text: string | null;
        try {
          text = await backend().read(area, path);
        } catch (e) {
          logError(`storage.read ${path}`, e);
          unreadable = true;
          return null;
        }
        unreadable = false;
        if (text != null) {
          // A write asked for meanwhile is newer than what's on disk.
          if (!writing) last = text;
          // A previous migration may have stopped before removing the old keys.
          if (legacy.length) void dropLegacy();
          return text;
        }
        for (const key of legacy) {
          const old = await store.get(key).catch(() => null);
          if (!old) continue;
          try {
            await backend().write(area, path, old);
            if (!writing) last = old;
            await dropLegacy();
          } catch (e) {
            // Keep the old keys: the migration runs again next start.
            logError(`storage.migrate ${path}`, e);
          }
          return old;
        }
        if (!writing) last = null;
        return null;
      });
    },
    write(text) {
      if (unreadable) {
        logError(`storage.write ${path}`, new Error('skipped: the file could not be read'));
        return Promise.resolve();
      }
      if (text === last || text === pending) return writing ?? Promise.resolve();
      last = text;
      pending = text;
      const g = gen;
      return (writing ??= queue(() => drain(g)));
    },
    remove() {
      gen++;
      pending = null;
      writing = null;
      last = null;
      return queue(async () => {
        await backend()
          .remove(area, path)
          .catch((e) => logError(`storage.remove ${path}`, e));
        await dropLegacy();
      });
    },
  };
}

/** A JSON value in a file (see textFile). `parse` checks what was read. */
export interface JsonFile<T> {
  readonly path: string;
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  remove(): Promise<void>;
  /** The last load failed for a reason other than a missing file (see TextFile.unreadable). */
  readonly unreadable?: boolean;
}

export function jsonFile<T>(area: Area, name: string, parse: (raw: unknown) => T | null, opts: TextFileOptions = {}): JsonFile<T> {
  const file = textFile(area, name, opts);
  return {
    path: file.path,
    get unreadable() {
      return file.unreadable;
    },
    async load() {
      const text = await file.read();
      if (text == null) return null;
      try {
        return parse(JSON.parse(text));
      } catch {
        return null; // corrupt: start over (the next save replaces it)
      }
    },
    save: (value) => file.write(JSON.stringify(value)),
    remove: () => file.remove(),
  };
}
