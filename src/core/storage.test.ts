import { describe, expect, it, vi } from 'vitest';
import type { FileBackend, KV } from './storage';

vi.mock('@capacitor/preferences', () => ({ Preferences: {} }));

const { jsonFile, textFile, localFiles, filePath, LOCAL_FILE_PREFIX } = await import('./storage');

function memKV(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  const kv: KV & { data: Map<string, string> } = {
    data,
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void data.set(k, v)),
    remove: vi.fn(async (k: string) => void data.delete(k)),
  };
  return kv;
}

function memFiles() {
  const data = new Map<string, string>();
  const backend: FileBackend & { data: Map<string, string>; writes: string[]; fail: boolean } = {
    data,
    writes: [],
    fail: false,
    read: vi.fn(async (area, path) => data.get(`${area}:${path}`) ?? null),
    write: vi.fn(async (area, path, text) => {
      await new Promise((r) => setTimeout(r, 1));
      if (backend.fail) throw new Error('disk full');
      backend.writes.push(text);
      data.set(`${area}:${path}`, text);
    }),
    remove: vi.fn(async (area, path) => void data.delete(`${area}:${path}`)),
  };
  return backend;
}

describe('paths', () => {
  it('puts data and cache files in their own folders', () => {
    expect(filePath('data', 'catalog-public')).toBe('cyberjuke/catalog-public.json');
    expect(filePath('cache', 'lyrics')).toBe('cyberjuke-cache/lyrics.json');
  });
});

describe('migration from Preferences', () => {
  it('copies the first old key found into the file, then removes every old key', async () => {
    const kv = memKV({ history: '[1,2]', recent: '[3]' });
    const fs = memFiles();
    const f = textFile('data', 'history', { backend: fs, kv, legacyKeys: ['history', 'recent'] });
    expect(await f.read()).toBe('[1,2]');
    expect(fs.data.get('data:cyberjuke/history.json')).toBe('[1,2]');
    expect(kv.data.size).toBe(0);
    // Next start: the file wins, Preferences isn't consulted.
    vi.mocked(kv.get).mockClear();
    expect(await textFile('data', 'history', { backend: fs, kv, legacyKeys: ['history', 'recent'] }).read()).toBe('[1,2]');
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('falls back to a later old key', async () => {
    const kv = memKV({ recent: '[3]' });
    const fs = memFiles();
    expect(await textFile('data', 'h', { backend: fs, kv, legacyKeys: ['history', 'recent'] }).read()).toBe('[3]');
    expect(kv.data.has('recent')).toBe(false);
  });

  it('keeps the old keys when the file write fails, so it runs again', async () => {
    const kv = memKV({ 'catalog.v1': '{"v":1}' });
    const fs = memFiles();
    fs.fail = true;
    const f = textFile('data', 'catalog-public', { backend: fs, kv, legacyKeys: ['catalog.v1'] });
    expect(await f.read()).toBe('{"v":1}');
    expect(kv.data.has('catalog.v1')).toBe(true);
    fs.fail = false;
    expect(await textFile('data', 'catalog-public', { backend: fs, kv, legacyKeys: ['catalog.v1'] }).read()).toBe('{"v":1}');
    expect(kv.data.has('catalog.v1')).toBe(false);
  });

  it('removes old keys left over when the file already exists', async () => {
    const kv = memKV({ 'lyrics.v1': 'old' });
    const fs = memFiles();
    fs.data.set('cache:cyberjuke-cache/lyrics.json', 'new');
    expect(await textFile('cache', 'lyrics', { backend: fs, kv, legacyKeys: ['lyrics.v1'] }).read()).toBe('new');
    await new Promise((r) => setTimeout(r, 0));
    expect(kv.data.has('lyrics.v1')).toBe(false);
  });

  it('returns null with no file and no old key', async () => {
    expect(await textFile('data', 'x', { backend: memFiles(), kv: memKV(), legacyKeys: ['a'] }).read()).toBeNull();
  });
});

describe('writes', () => {
  it('skips a write when nothing changed', async () => {
    const fs = memFiles();
    const f = jsonFile<{ a: number }>('data', 'x', (r) => r as { a: number }, { backend: fs, kv: memKV() });
    await f.save({ a: 1 });
    await f.save({ a: 1 });
    expect(fs.writes).toEqual(['{"a":1}']);
    expect(await f.load()).toEqual({ a: 1 });
    await f.save({ a: 1 });
    expect(fs.writes).toHaveLength(1);
    await f.save({ a: 2 });
    expect(fs.writes).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('never overlaps writes; the latest text wins', async () => {
    const fs = memFiles();
    const f = textFile('data', 'x', { backend: fs, kv: memKV() });
    const p = [f.write('1'), f.write('2'), f.write('3')];
    await Promise.all(p);
    expect(fs.writes).toEqual(['1', '3']);
    expect(fs.data.get('data:cyberjuke/x.json')).toBe('3');
  });

  it('retries a failed write the next time, even with the same text', async () => {
    const fs = memFiles();
    const f = textFile('data', 'x', { backend: fs, kv: memKV() });
    fs.fail = true;
    await f.write('a');
    fs.fail = false;
    await f.write('a');
    expect(fs.writes).toEqual(['a']);
  });

  it('a corrupt file loads as null', async () => {
    const fs = memFiles();
    fs.data.set('data:cyberjuke/x.json', '{nope');
    expect(await jsonFile('data', 'x', (r) => r, { backend: fs, kv: memKV() }).load()).toBeNull();
  });

  it('remove deletes the file and the old keys', async () => {
    const fs = memFiles();
    const kv = memKV({ old: '1' });
    const f = textFile('data', 'x', { backend: fs, kv, legacyKeys: ['old'] });
    await f.write('2');
    await f.remove();
    expect(fs.data.size).toBe(0);
    expect(kv.data.size).toBe(0);
    await f.write('2');
    expect(fs.writes).toEqual(['2', '2']);
  });
});

describe('browser fallback', () => {
  it('keeps files in localStorage under their path', async () => {
    const m = new Map<string, string>();
    const ls = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    const b = localFiles(ls);
    await b.write('cache', 'cyberjuke-cache/lyrics.json', 'x');
    expect(m.get(`${LOCAL_FILE_PREFIX}cache/cyberjuke-cache/lyrics.json`)).toBe('x');
    expect(await b.read('cache', 'cyberjuke-cache/lyrics.json')).toBe('x');
    await b.remove('cache', 'cyberjuke-cache/lyrics.json');
    expect(m.size).toBe(0);
  });
});
