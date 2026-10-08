/**
 * Lyrics panel for Now Playing. It replaces the album art in place (same frame and
 * size). Synced lyrics highlight and centre the current line, a tapped line seeks to
 * it, and scrolling by hand pauses the auto-scroll for MANUAL_PAUSE_MS. Lines carry
 * dir="auto" so right-to-left scripts render correctly; the font stack falls back to
 * system fonts for scripts the pixel fonts don't cover.
 */
import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { activeLine, lyrics as client, type Lyrics, type LyricsOutcome } from '../../data/lyrics';
import type { Track } from '../../data/model';
import { livePosition, player, type PlayerState } from '../../player';
import { online } from '../../store/network';

/** Lyrics shown instead of the art (kept across tracks and reopenings). */
export const lyricsOpen = signal(false);

export const MANUAL_PAUSE_MS = 4000;

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The source credit line ("Lyrics: LRCLIB", "Source: LyricFind"). Never names the video host. */
export function creditFor(source: string | undefined): string {
  const src = (source ?? '').trim();
  if (!src || /youtube/i.test(src)) return 'Source: LyricFind';
  if (/^source\s*:/i.test(src)) return src;
  if (/lyricfind/i.test(src)) return `Source: ${src}`;
  return `Lyrics: ${src}`;
}

type Load = { id: string; outcome: LyricsOutcome | null };

function useLyrics(track: Track, durationMs: number): [LyricsOutcome | null, () => void] {
  const [state, setState] = useState<Load>(() => {
    const hit = client.peek(track.id);
    return { id: track.id, outcome: hit ? { status: 'ok', lyrics: hit } : null };
  });
  const [attempt, setAttempt] = useState(0);
  // Wait for the duration (better matches) unless it takes long to arrive.
  const [durReady, setDurReady] = useState(durationMs > 0);
  useEffect(() => {
    if (durationMs > 0) return setDurReady(true);
    setDurReady(false);
    const id = setTimeout(() => setDurReady(true), 2500);
    return () => clearTimeout(id);
  }, [track.id, durationMs > 0]);
  useEffect(() => {
    let live = true;
    const hit = client.peek(track.id);
    if (hit) {
      setState({ id: track.id, outcome: { status: 'ok', lyrics: hit } });
      return;
    }
    setState({ id: track.id, outcome: null });
    if (!durReady) return;
    void client.get(track, durationMs).then((outcome) => live && setState({ id: track.id, outcome }));
    return () => {
      live = false;
    };
  }, [track.id, durReady, attempt]);
  return [state.id === track.id ? state.outcome : null, () => setAttempt((n) => n + 1)];
}

export function LyricsPanel({ track, s }: { track: Track; s: PlayerState }) {
  const [outcome, retry] = useLyrics(track, s.durationMs);
  const isOnline = online.value;
  let body;
  if (!outcome) body = <LyricsState text="[ fetching lyrics… ]" busy />;
  else if (outcome.status === 'error')
    body =
      outcome.offline || !isOnline ? (
        <LyricsState text="Lyrics unavailable offline" />
      ) : (
        <LyricsState text="Lyrics unavailable right now">
          <button class="link-btn" onClick={retry} data-testid="lyrics-retry">
            [Retry]
          </button>
        </LyricsState>
      );
  else if (!outcome.lyrics.found) body = <LyricsState text="No lyrics found" />;
  else if (outcome.lyrics.synced) body = <SyncedLyrics key={track.id} lyrics={outcome.lyrics} s={s} />;
  else if (outcome.lyrics.plain) body = <PlainLyrics key={track.id} text={outcome.lyrics.plain} />;
  else body = <LyricsState text="♪ Instrumental ♪" />;
  const credit = outcome?.status === 'ok' && outcome.lyrics.found ? creditFor(outcome.lyrics.source) : '';
  return (
    <div class="lyr" data-testid="np-lyrics" data-kind={kindOf(outcome)}>
      {body}
      {credit && (
        <div class="lyr-credit" data-testid="lyrics-credit">
          {credit}
        </div>
      )}
    </div>
  );
}

function kindOf(o: LyricsOutcome | null): string {
  if (!o) return 'loading';
  if (o.status === 'error') return 'error';
  const l = o.lyrics;
  return !l.found ? 'none' : l.synced ? 'synced' : l.plain ? 'plain' : 'instrumental';
}

function LyricsState({ text, busy, children }: { text: string; busy?: boolean; children?: ComponentChildren }) {
  return (
    <div class="lyr-state" data-testid="lyrics-state" aria-busy={busy}>
      <span>{text}</span>
      {children}
    </div>
  );
}

function PlainLyrics({ text }: { text: string }) {
  return (
    <div class="lyr-scroll lyr-plain" tabIndex={0} aria-label="Lyrics">
      {text.split('\n').map((line, i) =>
        line.trim() ? (
          <p key={i} class="lyr-line" dir="auto" data-testid="lyric-line">
            {line}
          </p>
        ) : (
          <div key={i} class="lyr-gap" aria-hidden="true" />
        ),
      )}
    </div>
  );
}

/** Re-render ~4x/s while playing. */
function useTick(s: PlayerState): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!s.isPlaying || s.isBuffering) return;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [s.isPlaying, s.isBuffering]);
  return livePosition(s);
}

function SyncedLyrics({ lyrics, s }: { lyrics: Lyrics; s: PlayerState }) {
  const lines = lyrics.synced!;
  const pos = useTick(s);
  const cur = activeLine(lines, pos + 150); // a little early reads better
  const box = useRef<HTMLDivElement>(null);
  const pausedUntil = useRef(0);
  const first = useRef(true);

  const pauseAuto = () => (pausedUntil.current = Date.now() + MANUAL_PAUSE_MS);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || Date.now() < pausedUntil.current) return;
    const line = el.querySelector<HTMLElement>(`[data-i="${Math.max(0, cur)}"]`);
    if (!line) return;
    const top = line.offsetTop - el.clientHeight / 2 + line.offsetHeight / 2;
    el.scrollTo({ top: Math.max(0, top), behavior: first.current || reducedMotion() ? 'auto' : 'smooth' });
    first.current = false;
  }, [cur]);

  // When a manual pause ends, re-centre without waiting for the next line.
  useEffect(() => {
    const id = setInterval(() => {
      const el = box.current;
      if (!el || !pausedUntil.current || Date.now() < pausedUntil.current) return;
      pausedUntil.current = 0;
      const line = el.querySelector<HTMLElement>('.lyr-line.on');
      if (line) el.scrollTo({ top: Math.max(0, line.offsetTop - el.clientHeight / 2 + line.offsetHeight / 2), behavior: reducedMotion() ? 'auto' : 'smooth' });
    }, 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      class="lyr-scroll lyr-synced"
      ref={box}
      onWheel={pauseAuto}
      onTouchStart={pauseAuto}
      onTouchMove={pauseAuto}
      onKeyDown={(e) => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key) && (e.target as HTMLElement) === box.current) pauseAuto();
      }}
      tabIndex={0}
      aria-label="Synced lyrics"
      data-testid="lyrics-synced"
      data-current={cur}
    >
      {lines.map((l, i) =>
        l.text ? (
          <button
            key={i}
            class={'lyr-line' + (i === cur ? ' on' : i < cur ? ' past' : '')}
            dir="auto"
            data-i={i}
            data-t={l.t}
            aria-current={i === cur ? 'true' : undefined}
            onClick={() => {
              pausedUntil.current = 0;
              void player.seek(l.t);
            }}
            data-testid="lyric-line"
          >
            {l.text}
          </button>
        ) : (
          <div key={i} class={'lyr-gap' + (i === cur ? ' on' : '')} data-i={i} aria-hidden="true">
            ♪
          </div>
        ),
      )}
    </div>
  );
}
