/**
 * Lyrics panel for Now Playing. It replaces the album art in place (same frame and
 * size). Synced lyrics highlight and centre the current line, a tapped line seeks to
 * it, and scrolling by hand pauses the auto-scroll for MANUAL_PAUSE_MS. A tap that
 * lands while the panel is gliding to the next line only stops it (clickGuard): it
 * doesn't seek to whatever line was passing under the finger. Lines carry
 * dir="auto" so right-to-left scripts render correctly; the font stack falls back to
 * system fonts for scripts the pixel fonts don't cover.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { activeLine, lyrics as client, type Lyrics, type LyricsOutcome } from '../../data/lyrics';
import type { Track } from '../../data/model';
import { durationMs, isAdvancing, livePosition, player, type PlayerState } from '../../player';
import { online } from '../../core/network';
import { smoothScrolling } from '../../ui/clickGuard';
import { reducedMotion } from '../../core/motion';
import { useTickValue } from '../../ui/useTick';

const MANUAL_PAUSE_MS = 4000;

/** The source credit line ("Lyrics: LRCLIB", "Source: LyricFind"). Never names the video host. */
function creditFor(source: string | undefined): string {
  const src = (source ?? '').trim();
  if (!src || /youtube/i.test(src)) return 'Source: LyricFind';
  if (/^source\s*:/i.test(src)) return src;
  if (/lyricfind/i.test(src)) return `Source: ${src}`;
  return `Lyrics: ${src}`;
}

type Load = { id: string; outcome: LyricsOutcome | null };

/** How long lyrics wait for the track's duration before asking without it. */
const LYRICS_DURATION_WAIT_MS = 2500;

function useLyrics(track: Track, durationMs: number): [LyricsOutcome | null, () => void] {
  const [state, setState] = useState<Load>(() => {
    const hit = client.peek(track.id);
    return { id: track.id, outcome: hit ? { status: 'ok', lyrics: hit } : null };
  });
  const [attempt, setAttempt] = useState(0);
  // Wait for this track's duration (better matches) unless it takes long to arrive. Kept per
  // track: on a skip, the last track's "ready" must not let the next one ask without it.
  const [waitedFor, setWaitedFor] = useState<string | null>(null);
  const durReady = durationMs > 0 || waitedFor === track.id;
  useEffect(() => {
    if (durationMs > 0) return;
    const id = setTimeout(() => setWaitedFor(track.id), LYRICS_DURATION_WAIT_MS);
    return () => clearTimeout(id);
    // Only whether a duration is known matters, not its value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, durationMs > 0]);
  useEffect(() => {
    let live = true;
    const hit = client.peek(track.id);
    if (hit) {
      setState({ id: track.id, outcome: { status: 'ok', lyrics: hit } });
      return;
    }
    setState({ id: track.id, outcome: null });
    // Not known yet (a placeholder while the list resolves): wait for the real track.
    if (!durReady || !track.ytId) return;
    void client.get(track, durationMs).then((outcome) => live && setState({ id: track.id, outcome }));
    return () => {
      live = false;
    };
    // Keyed by the track's id: a new Track object for the same id (or a duration update) mustn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, !!track.ytId, durReady, attempt]);
  return [state.id === track.id ? state.outcome : null, () => setAttempt((n) => n + 1)];
}

export function LyricsPanel({ track }: { track: Track }) {
  const [outcome, retry] = useLyrics(track, durationMs.value);
  const isOnline = online.value;
  const failed = outcome?.status === 'error';
  // Back online after a failure: try again by itself.
  useEffect(() => {
    if (isOnline && failed) retry();
    // Only the connection coming back counts, not a new failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);
  let body;
  if (!outcome) body = <LyricsState text="[ fetching lyrics… ]" busy />;
  else if (outcome.status === 'error')
    body =
      // Offline only when the device is: a failed request while online offers Retry.
      !isOnline ? (
        <LyricsState text="Lyrics unavailable offline" />
      ) : (
        <LyricsState text="Lyrics unavailable right now">
          <button class="link-btn" onClick={retry} data-testid="lyrics-retry">
            [Retry]
          </button>
        </LyricsState>
      );
  else if (!outcome.lyrics.found) body = <LyricsState text="No lyrics found" />;
  else if (outcome.lyrics.synced) body = <SyncedLyrics key={track.id} lyrics={outcome.lyrics} />;
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

function SyncedLyrics({ lyrics }: { lyrics: Lyrics }) {
  const lines = lyrics.synced!;
  // A little early reads better. Re-renders only when the line changes.
  const lineAt = (st: PlayerState) => activeLine(lines, livePosition(st) + 150);
  const cur = useTickValue(isAdvancing.value, () => lineAt(player.state.peek()));
  const box = useRef<HTMLDivElement>(null);
  const pausedUntil = useRef(0);
  const first = useRef(true);
  const resume = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Scroll the panel to `top`, gliding unless `instant` (or reduced motion). */
  const follow = (el: HTMLElement, top: number, instant: boolean) => {
    const smooth = !instant && !reducedMotion() && Math.abs(el.scrollTop - Math.max(0, top)) > 1;
    el.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
    if (smooth) smoothScrolling(el);
  };
  const centre = (smooth: boolean) => {
    const el = box.current;
    const line = el?.querySelector<HTMLElement>('.lyr-line.on');
    if (el && line) follow(el, line.offsetTop - el.clientHeight / 2 + line.offsetHeight / 2, !smooth);
  };

  // Scrolling by hand pauses the auto-scroll; when the pause ends, re-centre without
  // waiting for the next line (a timer per pause, no polling).
  const pauseAuto = () => {
    pausedUntil.current = Date.now() + MANUAL_PAUSE_MS;
    if (resume.current) clearTimeout(resume.current);
    resume.current = setTimeout(() => {
      resume.current = null;
      pausedUntil.current = 0;
      centre(true);
    }, MANUAL_PAUSE_MS);
  };
  // Passive native listeners: a JSX touch handler would hold up every scroll start.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    for (const t of ['wheel', 'touchstart', 'touchmove'] as const) el.addEventListener(t, pauseAuto, { passive: true });
    return () => {
      for (const t of ['wheel', 'touchstart', 'touchmove'] as const) el.removeEventListener(t, pauseAuto);
      if (resume.current) clearTimeout(resume.current);
    };
    // Mount-only: `pauseAuto` reads only refs (and `centre`, which reads only refs).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || Date.now() < pausedUntil.current) return;
    const line = el.querySelector<HTMLElement>(`[data-i="${Math.max(0, cur)}"]`);
    if (!line) return;
    follow(el, line.offsetTop - el.clientHeight / 2 + line.offsetHeight / 2, first.current);
    first.current = false;
  }, [cur]);

  return (
    <div
      class="lyr-scroll lyr-synced"
      ref={box}
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
            class={'lyr-line' + (i === cur ? ' on' : '')}
            dir="auto"
            data-i={i}
            data-t={l.t}
            aria-current={i === cur ? 'true' : undefined}
            onClick={() => {
              pausedUntil.current = 0;
              if (resume.current) clearTimeout(resume.current);
              resume.current = null;
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
