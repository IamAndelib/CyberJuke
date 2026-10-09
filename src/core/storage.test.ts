import { describe, expect, it, vi } from 'vitest';
import type { FileBackend, KV } from './storage';

vi.mock('@capacitor/preferences', () => ({ Preferences: {} }));

const { jsonFile, textFile, localFiles, filePath, isMissingFile, LOCAL_FILE_PREFIX } = await import('./storage');

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
    // Writes asked for while one is queued or going collapse into the latest.
    expect(fs.writes).toEqual(['3']);
    expect(fs.data.get('data:cyberjuke/x.json')).toBe('3');
    await f.write('4');
    const late = [f.write('5'), f.write('6')];
    await Promise.all(late);
    expect(fs.writes).toEqual(['3', '4', '6']);
  });

  it('remove waits for a write still going: the file does not come back', async () => {
    const fs = memFiles();
    const f = textFile('data', 'catalog-members', { backend: fs, kv: memKV() });
    const w = f.write('MEMBERS');
    await Promise.resolve();
    await f.remove();
    await w;
    expect(fs.data.has('data:cyberjuke/catalog-members.json')).toBe(false);
    // A write after the remove lands after it.
    void f.write('A');
    const r = f.remove();
    const w2 = f.write('B');
    await Promise.all([r, w2]);
    expect(fs.data.get('data:cyberjuke/catalog-members.json')).toBe('B');
  });

  it('a read while a write is queued sees that write, and a later save of the read text is not skipped', async () => {
    const fs = memFiles();
    fs.data.set('data:cyberjuke/history.json', 'FULL');
    const f = textFile('data', 'history', { backend: fs, kv: memKV() });
    const w = f.write('ONE');
    expect(await f.read()).toBe('ONE');
    await f.write('FULL');
    await w;
    expect(fs.data.get('data:cyberjuke/history.json')).toBe('FULL');
  });

  it('the migration write goes through the same queue as other writes', async () => {
    const kv = memKV({ old: 'OLD' });
    const fs = memFiles();
    const f = textFile('data', 'h', { backend: fs, kv, legacyKeys: ['old'] });
    const r = f.read();
    const w = f.write('NEW');
    expect(await r).toBe('OLD');
    await w;
    expect(fs.writes).toEqual(['OLD', 'NEW']);
    expect(fs.data.get('data:cyberjuke/h.json')).toBe('NEW');
  });

  it('a file that is there but cannot be read is not overwritten until a read works', async () => {
    const fs = memFiles();
    fs.data.set('data:cyberjuke/history.json', '["real"]');
    vi.mocked(fs.read).mockRejectedValueOnce(new Error('EIO'));
    const f = jsonFile('data', 'history', (r) => r, { backend: fs, kv: memKV() });
    expect(await f.load()).toBeNull();
    expect(f.unreadable).toBe(true);
    await f.save(['one']);
    expect(fs.data.get('data:cyberjuke/history.json')).toBe('["real"]');
    // Retried later: the read works, and writes go through again.
    expect(await f.load()).toEqual(['real']);
    expect(f.unreadable).toBe(false);
    await f.save(['one']);
    expect(fs.data.get('data:cyberjuke/history.json')).toBe('["one"]');
  });

  it('a missing file is not a read error', async () => {
    const fs = memFiles();
    const f = textFile('data', 'x', { backend: fs, kv: memKV() });
    expect(await f.read()).toBeNull();
    expect(f.unreadable).toBe(false);
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

describe('native files', () => {
  it('tells a missing file from a read error', () => {
    expect(isMissingFile({ code: 'OS-PLUG-FILE-0008', message: "'readFile' failed because file at 'x' does not exist." })).toBe(true);
    expect(isMissingFile(new Error('File does not exist'))).toBe(true);
    expect(isMissingFile({ code: 'OS-PLUG-FILE-0013', message: "'readFile' failed with: I/O error" })).toBe(false);
    expect(isMissingFile(null)).toBe(false);
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
