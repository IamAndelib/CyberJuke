#!/usr/bin/env node
// Regenerates src/data/radio/stations.json, the bundled Signal Radio stations, from
// hyphen8d/signal (MIT, Copyright (c) 2026 Matthew Arevalo) at a pinned commit.
//
//   npm run stations                 download stations.md and stations.js at COMMIT
//   npm run stations -- --from DIR   read the two files from DIR instead
//
// A refresh is a reviewed PR that bumps COMMIT. Both files are read as text and never
// imported or evaluated: the tracks come from the generated roster (stations.md), and each
// station's id, band and description from its header line and `desc:` field in stations.js
// (the public STATIONS only), matched by callsign. No dependencies.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'hyphen8d/signal';
const COMMIT = '174512c46e01c93568e77099d25737a867101773';
const STATION_COUNT = 16;
const BANDS = ['ym', 'zm'];
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'radio', 'stations.json');

function fail(msg) {
  throw new Error(msg);
}

async function load(name, from) {
  if (from) return readFile(join(from, name), 'utf8');
  const url = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/${name}`;
  const res = await fetch(url);
  if (!res.ok) fail(`${url}: HTTP ${res.status}`);
  return res.text();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** Markdown backslash escapes and HTML entities, decoded; a bare `&` stays as it is. */
function mdText(s) {
  return s
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>~"'&])/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

/** The roster: bands, stations (callsign, freq, tagline) and their tracks, in file order. */
function parseRoster(md) {
  const lines = md.split(/\r?\n/);
  const total = /(\d+) stations, (\d+) tracks total/.exec(md) ?? fail('stations.md: no "N stations, M tracks total" line');
  const stations = [];
  let band = null;
  let st = null;
  for (const line of lines) {
    let m;
    if ((m = /^# (YM|ZM) band\s*$/.exec(line))) {
      band = m[1].toLowerCase();
      st = null;
    } else if ((m = /^## (.+?) -- (\d+(?:\.\d+)?)\s*$/.exec(line))) {
      if (!band) fail(`stations.md: station before a band: ${line}`);
      st = { band, callsign: mdText(m[1]), freq: Number(m[2]), tagline: '', tracks: [] };
      stations.push(st);
    } else if (st && !st.tagline && !st.tracks.length && (m = /^\*(.+)\*\s*$/.exec(line))) {
      st.tagline = mdText(m[1]);
    } else if ((m = /^\d+\. \*\*(.+?)\*\* -- (.+?) {2}\(\[youtu\.be\/([^\]]+)\]\(https:\/\/youtu\.be\/([^)]+)\)\)\s*$/.exec(line))) {
      if (!st) fail(`stations.md: track before a station: ${line}`);
      if (m[3] !== m[4]) fail(`stations.md: link text and target differ: ${line}`);
      st.tracks.push({ ytId: m[3], title: mdText(m[1]), artist: mdText(m[2]) });
    } else if (st && /^\d+\. /.test(line)) {
      fail(`stations.md: unreadable track line: ${line}`);
    }
  }
  return { stations, totalStations: Number(total[1]), totalTracks: Number(total[2]) };
}

/** One JavaScript string literal ('…' or "…") at the start of `s`, decoded without evaluating it. */
function jsString(s) {
  const q = s[0];
  if (q !== "'" && q !== '"') fail(`stations.js: not a string literal: ${s.slice(0, 40)}`);
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === q) return out;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[++i];
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      out += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out += n;
  }
  fail(`stations.js: unterminated string: ${s.slice(0, 40)}`);
}

/** The public STATIONS' id, band, freq, callsign and desc, by callsign. */
function parseSource(js) {
  const start = js.indexOf('export const STATIONS = [');
  const end = js.indexOf('export const STATION_PRESET_ORDER');
  if (start < 0 || end < start) fail('stations.js: no STATIONS list');
  const lines = js.slice(start, end).split(/\r?\n/);
  const HEAD = /^ {2}\{ id: '([a-z0-9-]+)', band: '(ym|zm)', freq: (\d+(?:\.\d+)?), callsign: '([^'\\]+)',/;
  const out = new Map();
  let st = null;
  for (const line of lines) {
    const h = HEAD.exec(line);
    if (h) {
      st = { id: h[1], band: h[2], freq: Number(h[3]), callsign: h[4], desc: null };
      if (out.has(st.callsign)) fail(`stations.js: callsign twice: ${st.callsign}`);
      out.set(st.callsign, st);
      continue;
    }
    const d = /^ {4}desc: (.*?),?\s*$/.exec(line);
    if (st && d && st.desc == null) st.desc = jsString(d[1]).trim();
  }
  return out;
}

/** Control, zero-width and bidi characters: nothing the app should show, and they can hide text from a review. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses.
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
/** Longest text a field may have (the longest today is a 199-character description). */
const MAX_TEXT = 300;

/** Text shown in the app, as upstream wrote it: no hidden characters, not absurdly long. */
function checkText(where, s) {
  if (HIDDEN_CHARS.test(s)) fail(`${where}: control or bidi character`);
  if (s.length > MAX_TEXT) fail(`${where}: over ${MAX_TEXT} characters`);
}

function build(md, js) {
  const roster = parseRoster(md);
  const source = parseSource(js);
  if (roster.stations.length !== STATION_COUNT || roster.totalStations !== STATION_COUNT) {
    fail(`expected ${STATION_COUNT} stations, the roster has ${roster.stations.length} (says ${roster.totalStations})`);
  }
  if (source.size !== STATION_COUNT) fail(`expected ${STATION_COUNT} public stations in stations.js, found ${source.size}`);
  const ids = new Set();
  const stations = roster.stations.map((r) => {
    const s = source.get(r.callsign) ?? fail(`stations.js has no station ${r.callsign}`);
    if (s.band !== r.band || s.freq !== r.freq) fail(`${r.callsign}: band/freq differ between stations.md and stations.js`);
    if (!s.desc) fail(`${r.callsign}: no desc`);
    if (!r.tagline) fail(`${r.callsign}: no tagline`);
    if (!r.tracks.length) fail(`${r.callsign}: no tracks`);
    if (ids.has(s.id)) fail(`station id twice: ${s.id}`);
    ids.add(s.id);
    const seen = new Set();
    for (const t of r.tracks) {
      if (!YT_ID.test(t.ytId)) fail(`${r.callsign}: bad video id ${t.ytId}`);
      // A track's id is sig:<station>:<video id>: one video twice on a station would be two tracks with one id.
      if (seen.has(t.ytId)) fail(`${r.callsign}: video ${t.ytId} twice`);
      seen.add(t.ytId);
      if (!t.title || !t.artist) fail(`${r.callsign}: track ${t.ytId} has no title or artist`);
      checkText(`${r.callsign}: track ${t.ytId} title`, t.title);
      checkText(`${r.callsign}: track ${t.ytId} artist`, t.artist);
    }
    for (const [k, v] of [['callsign', r.callsign], ['tagline', r.tagline], ['desc', s.desc]]) checkText(`${r.callsign}: ${k}`, v);
    return { id: s.id, band: r.band, freq: r.freq, callsign: r.callsign, tagline: r.tagline, desc: s.desc, tracks: r.tracks };
  });
  const tracks = stations.reduce((n, s) => n + s.tracks.length, 0);
  if (tracks !== roster.totalTracks) fail(`the roster says ${roster.totalTracks} tracks, found ${tracks}`);
  for (const b of BANDS) if (!stations.some((s) => s.band === b)) fail(`no ${b} stations`);
  stations.sort((a, b) => BANDS.indexOf(a.band) - BANDS.indexOf(b.band) || a.freq - b.freq);
  return { data: { source: { repo: REPO, commit: COMMIT }, stations }, tracks };
}

/** JSON with one line per track, so a refresh reviews as a readable diff. */
function format({ source, stations }) {
  const j = JSON.stringify;
  const station = ({ tracks, ...s }) => {
    const head = Object.entries(s).map(([k, v]) => `   ${j(k)}: ${j(v)},`);
    return ['  {', ...head, '   "tracks": [', tracks.map((t) => `    ${j(t)}`).join(',\n'), '   ]', '  }'].join('\n');
  };
  return `{\n "source": ${j(source)},\n "stations": [\n${stations.map(station).join(',\n')}\n ]\n}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--from');
  const from = at >= 0 ? (args[at + 1] ?? fail('--from needs a directory')) : null;
  const [md, js] = await Promise.all([load('stations.md', from), load('stations.js', from)]);
  const { data, tracks } = build(md, js);
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, format(data));
  console.info(`Wrote ${data.stations.length} stations, ${tracks} tracks (${REPO}@${COMMIT.slice(0, 7)}).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
