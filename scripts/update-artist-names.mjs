#!/usr/bin/env node
// Regenerates src/data/artistNames.json: well-known artists whose name holds a separator the
// app splits credits on (", " "; " " / " feat.), so "Earth, Wind & Fire" stays one artist.
//
//   npm run artist-names                  stream the artist table out of the pinned MusicBrainz
//                                         full export (needs `bzip2` on the PATH)
//   npm run artist-names -- --from FILE   read that table (mbdump/artist, extracted) from FILE
//
// Names: the MusicBrainz artist table (CC0) of the full export DUMP, checked by its sha256.
// Popularity: ListenBrainz's artist popularity (CC0), the one live input: an artist listened to
// by at least MIN_USERS people is kept. MetaBrainz keeps only the latest few exports, so a
// refresh is a reviewed PR that bumps DUMP and TABLE_SHA256. No dependencies.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const DUMP = '20261101-125824';
const DUMP_URL = `https://data.metabrainz.org/pub/musicbrainz/data/fullexport/${DUMP}/mbdump.tar.bz2`;
const TABLE = 'mbdump/artist';
const TABLE_SHA256 = '577b29786dfffb76ed199991e9f7a1a2aaf74cda23ddfac815151f3ca9e67f3a';
const POPULARITY_URL = 'https://api.listenbrainz.org/1/popularity/artist';
const MIN_USERS = 200;
const UA = 'CyberJuke-build/1.0 (https://github.com/IamAndelib/CyberJuke)';
/** Names to keep whole that the popularity cut misses. Hand-maintained; keep it short. */
const EXTRA = [];
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'artistNames.json');

// The same rules as src/data/artists.ts: what splits a credit, and the suffixes a comma keeps.
const SEPARATOR = /\s*(?:[,;]|\s\/|\/\s|\s(?:feat\.?|ft\.?|featuring)\s)\s*/i;
const SUFFIX = /,\s*(?:jr|sr|ii|iii|iv|inc|ltd)\.?(?=\s*(?:$|[,;)\]]|\/|\s(?:feat\.?|ft\.?|featuring)\s))/gi;
/** The app's name key (normalize in src/data/text.ts, "&" read as "and"). */
const FOLD = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };
const key = (s) =>
  s
    .replace(/&/g, ' and ')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (c) => FOLD[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

// eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses.
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const MAX_NAME = 100;

function fail(msg) {
  throw new Error(msg);
}

/** The bytes of one member of a tar stream, then stop reading. */
async function* tarMember(chunks, name) {
  let buf = Buffer.alloc(0);
  let left = -1; // bytes of the member still to come; -1 while reading headers
  let skip = 0;
  for await (const chunk of chunks) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length) {
      if (left >= 0) {
        const n = Math.min(left, buf.length);
        yield buf.subarray(0, n);
        buf = buf.subarray(n);
        if ((left -= n) === 0) return;
      } else if (skip) {
        const n = Math.min(skip, buf.length);
        buf = buf.subarray(n);
        skip -= n;
      } else if (buf.length >= 512) {
        const head = buf.subarray(0, 512);
        buf = buf.subarray(512);
        const member = head.toString('utf8', 0, 100).replace(/\0.*$/s, '');
        if (!member) fail(`${TABLE} is not in the export`);
        const size = parseInt(head.toString('utf8', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8);
        if (member === name) left = size;
        else skip = Math.ceil(size / 512) * 512;
      } else break;
    }
  }
  fail(`the export ended before ${TABLE}`);
}

/** The artist table, streamed out of the export without saving the 7 GB file. */
async function* fromDump() {
  const abort = new AbortController();
  const res = await fetch(DUMP_URL, { headers: { 'User-Agent': UA }, signal: abort.signal });
  if (!res.ok) fail(`${DUMP_URL}: HTTP ${res.status}`);
  const bz = spawn('bzip2', ['-dc'], { stdio: ['pipe', 'pipe', 'inherit'] });
  bz.stdin.on('error', () => {}); // closed early, once the table is read
  Readable.fromWeb(res.body).on('error', () => {}).pipe(bz.stdin);
  try {
    yield* tarMember(bz.stdout, TABLE);
  } finally {
    abort.abort();
    bz.kill();
  }
}

/** PostgreSQL COPY text: \t, \n, \r and \\ escaped. */
const unescape = (s) => s.replace(/\\(.)/g, (_, c) => ({ t: '\t', n: '\n', r: '\r' })[c] ?? c);

/** [mbid, name] of every artist whose name the app would split, and the table's sha256. */
async function candidates(chunks) {
  const hash = createHash('sha256');
  const out = [];
  let rest = '';
  const take = (line) => {
    const [, gid, name] = line.split('\t');
    if (gid && name) {
      const n = unescape(name);
      if (SEPARATOR.test(n.replace(SUFFIX, ''))) out.push([gid, n]);
    }
  };
  const dec = new TextDecoder();
  for await (const chunk of chunks) {
    hash.update(chunk);
    const lines = (rest + dec.decode(chunk, { stream: true })).split('\n');
    rest = lines.pop();
    lines.forEach(take);
  }
  if (rest) take(rest);
  return { out, sha256: hash.digest('hex') };
}

/** ListenBrainz listeners per artist, 1000 a request, a second apart (its limit is 30 per 10 s). */
async function listeners(mbids) {
  const users = new Map();
  for (let i = 0; i < mbids.length; i += 1000) {
    const res = await fetch(POPULARITY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ artist_mbids: mbids.slice(i, i + 1000) }),
    });
    if (!res.ok) fail(`${POPULARITY_URL}: HTTP ${res.status}`);
    for (const a of await res.json()) users.set(a.artist_mbid, a.total_user_count ?? 0);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return users;
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--from');
  const from = at >= 0 ? (args[at + 1] ?? fail('--from needs a file')) : null;
  const { out, sha256 } = await candidates(from ? createReadStream(from) : fromDump());
  if (sha256 !== TABLE_SHA256) fail(`${TABLE}: sha256 ${sha256}, expected ${TABLE_SHA256}`);
  const users = await listeners([...new Set(out.map(([gid]) => gid))]);
  // One spelling per key: the most listened-to, then the first in code-point order.
  const best = new Map();
  for (const [gid, name] of out) {
    const u = users.get(gid) ?? 0;
    if (u < MIN_USERS || name.length > MAX_NAME || HIDDEN_CHARS.test(name)) continue;
    const k = key(name);
    const had = best.get(k);
    if (!had || u > had.u || (u === had.u && name < had.name)) best.set(k, { u, name });
  }
  for (const name of EXTRA) if (!best.has(key(name))) best.set(key(name), { u: 0, name });
  const names = [...best.values()].map((b) => b.name).sort();
  const source = { musicbrainz: `fullexport/${DUMP} ${TABLE}`, sha256, popularity: 'ListenBrainz', minUsers: MIN_USERS };
  const j = JSON.stringify;
  await writeFile(OUT, `{\n "source": ${j(source)},\n "names": [\n${names.map((n) => `  ${j(n)}`).join(',\n')}\n ]\n}\n`);
  console.info(`Wrote ${names.length} names (${out.length} candidates, MusicBrainz ${DUMP}).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
