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
 * written, writes to one file never overlap (the latest one wins), and a native
 * write goes to `<path>.tmp` first and is renamed over the file, so a crash can't
 * leave half a catalog behind.
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

export type Area = 'data' | 'cache';
export const AREA_DIRS: Record<Area, string> = { data: 'cyberjuke', cache: 'cyberjuke-cache' };

export function filePath(area: Area, name: string): string {
  return `${AREA_DIRS[area]}/${name}.json`;
}

/** Where file text lives: the device filesystem, or localStorage in the browser. */
export interface FileBackend {
  /** The file's text, or null when there is none. */
  read(area: Area, path: string): Promise<string | null>;
  write(area: Area, path: string, text: string): Promise<void>;
  remove(area: Area, path: string): Promise<void>;
}

/** @capacitor/filesystem, Directory.Data / Directory.Cache. */
export function nativeFiles(): FileBackend {
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
      } catch {
        return null; // missing (or unreadable: treated the same)
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
export function files(): FileBackend {
  return (defaultBackend ??= Capacitor.isNativePlatform() ? nativeFiles() : localFiles());
}

export interface TextFileOptions {
  backend?: FileBackend;
  /** Preferences keys this file replaces (newest shape first). */
  legacyKeys?: readonly string[];
  kv?: KV;
}

export interface TextFile {
  readonly path: string;
  /** The text (migrating old keys on first use), or null. Never rejects. */
  read(): Promise<string | null>;
  /** Write unless it's what the file already holds. Never rejects (failures are logged). */
  write(text: string): Promise<void>;
  remove(): Promise<void>;
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

  async function drain(): Promise<void> {
    while (pending != null) {
      const text = pending;
      pending = null;
      try {
        await backend().write(area, path, text);
      } catch (e) {
        logError(`storage.write ${path}`, e);
        if (last === text) last = undefined; // retry next time, even with the same text
      }
    }
    writing = null;
  }

  async function dropLegacy(): Promise<void> {
    for (const key of legacy) await store.remove(key).catch(() => {});
  }

  return {
    path,
    async read() {
      let text: string | null = null;
      try {
        text = await backend().read(area, path);
      } catch (e) {
        logError(`storage.read ${path}`, e);
      }
      if (text != null) {
        last = text;
        // A previous migration may have stopped before removing the old keys.
        if (legacy.length) void dropLegacy();
        return text;
      }
      for (const key of legacy) {
        const old = await store.get(key).catch(() => null);
        if (!old) continue;
        try {
          await backend().write(area, path, old);
          last = old;
          await dropLegacy();
        } catch (e) {
          // Keep the old keys: the migration runs again next start.
          logError(`storage.migrate ${path}`, e);
        }
        return old;
      }
      last = null;
      return null;
    },
    write(text) {
      if (text === last || text === pending) return writing ?? Promise.resolve();
      last = text;
      pending = text;
      return (writing ??= drain());
    },
    async remove() {
      pending = null;
      last = null;
      await backend()
        .remove(area, path)
        .catch((e) => logError(`storage.remove ${path}`, e));
      await dropLegacy();
    },
  };
}

/** A JSON value in a file (see textFile). `parse` checks what was read. */
export interface JsonFile<T> {
  readonly path: string;
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  remove(): Promise<void>;
}

export function jsonFile<T>(area: Area, name: string, parse: (raw: unknown) => T | null, opts: TextFileOptions = {}): JsonFile<T> {
  const file = textFile(area, name, opts);
  return {
    path: file.path,
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
