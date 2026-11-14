import { Fragment } from 'preact';
import { signal } from '@preact/signals';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { autoplayLabel, currentId, currentPlaysOffline, currentTrack, isPlaying, lapTracks, player, playContext, previousTracks, repeatMode, saveSongs, shuffleOn, undoOf, upNextSections, type PlayContext, type UpItem, type UpNextKind } from '../../player';
import { isLocal, type Track } from '../../data/model';
import { online } from '../../core/network';
import { settings } from '../../stores/library';
import { isSaved, savedOffline } from '../../stores/savedOffline';
import { glow, glowRow, type Glow } from '../../stores/glow';
import { toast } from '../../stores/toast';
import { PLAYLISTS_MAX, createPlaylist } from '../../stores/playlists';
import { askName } from '../../ui/nav';
import { Icon } from '../../ui/icons';
import { afterPress } from '../../ui/press';
import { Art } from '../../ui/components/Art';
import { Bars, longPress } from '../../ui/components/TrackRow';
import { UP_NEXT_MAX } from '../../core/guards';
import { plural } from '../../core/text';

type Kind = UpNextKind;

/**
 * "[+] Played": open for the list it was opened on (across closing Now Playing and track
 * changes), folded again when a new list starts. Folded by default, as history is elsewhere.
 */
const playedOpenFor = signal<PlayContext | null | undefined>(undefined);

/** After a removal the rows shift up: taps on the buttons column are ignored this long (M2). */
const REMOVE_GUARD_MS = 300;

/** A row's button had focus when it moved or went: where focus goes once Up next shows it. */
interface Refocus {
  /** The row: its track and section, at this place in the list (or anywhere: null). */
  id: string;
  kind: Kind;
  index: number | null;
  /** Its button: this one, else (disabled at the end of the section) the other arrow, else Remove. */
  button: RowButton;
  /** Not before this row (the one removed: id and index) has gone. */
  gone?: [string, number];
  /** Given up after this (the player didn't follow). */
  until: number;
}
const REFOCUS_MS = 2000;

type RowButton = 'up' | 'down' | 'remove';

const rowAt = (id: string, index: number) => `li[data-section][data-track-id="${CSS.escape(id)}"][data-index="${index}"]`;

function focusRow(root: HTMLElement, r: Refocus): boolean {
  if (r.gone && root.querySelector(rowAt(...r.gone))) return false;
  const index = r.index == null ? '' : `[data-index="${r.index}"]`;
  const row = root.querySelector(`li[data-section="${r.kind}"][data-track-id="${CSS.escape(r.id)}"]${index}`);
  if (!row) return false;
  const pick: RowButton[] = [r.button, r.button === 'up' ? 'down' : 'up', 'remove'];
  for (const b of pick) {
    const el = row.querySelector<HTMLButtonElement>(`[data-role="${b}"]:not(:disabled)`);
    if (el) {
      el.focus({ preventScroll: true });
      return true;
    }
  }
  return false;
}

/** A row's art and text; the playing track's art carries the visualiser (or ⏸), as in every list. */
function RowBody({ track, playing }: { track: Track; playing?: boolean }) {
  return (
    <>
      <div class="row-art">
        <Art track={track} size="sm" />
        {playing != null && <div class="row-art-badge">{playing ? <Bars /> : <Icon name="pause" size={18} />}</div>}
      </div>
      <div class="row-text">
        <div class="row-title">{track.title}</div>
        <div class="row-artist">{track.artist}</div>
        {isLocal(track) && (
          <div class="row-meta">
            <span class="tag" data-testid="local-tag">
              On phone
            </span>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * [Save queue as playlist]: New playlist with the list you're in and the songs you queued
 * (saveSongs). `shown`: the rows as they show (at most 50 on each side of the playing song), the
 * play order when shuffled.
 */
function saveQueue(shown: Track[]): void {
  const songs = saveSongs({ ...player.state.peek(), shown });
  askName({
    title: 'New playlist',
    note: `With ${plural(songs.length, 'song')}`,
    confirm: 'Create',
    run: (name) => {
      const r = createPlaylist(name, songs);
      if (r.result === 'created') toast(`Saved as ${name}`);
      else if (r.result === 'full') toast(`You have ${PLAYLISTS_MAX} playlists, the most there can be`);
    },
  });
}

/** Up next fills up to this many rows with the list on the way: one more shows as each song ends (D1). */
const WAY_FILL = 25;

/** A count Up next shows: "50+" when it may hold more than it shows. */
const upTo = (n: number) => (n >= UP_NEXT_MAX ? `${UP_NEXT_MAX}+` : n);

/**
 * Removes a queue row, with Undo: the same song back, as it was, where it was (K3, undoOf): its kind,
 * autoplay tag, heard state and queued-by-you mark (rule 8), before the song that followed it in play
 * order. The Undo goes once a new list or another track starts, or Repeat changes (Repeat all drops what
 * isn't the list you're in), when "back where it was" no longer means anything.
 */
export function removeWithUndo(it: UpItem, kind: Kind): void {
  const s = player.state.peek();
  // A row the queue has moved on from (its track playing now, or at another place) stays.
  if (s.queue[it.index]?.id !== it.track.id) return;
  const undo = undoOf(s, it, kind);
  void player.remove(it.index, it.track.id);
  const ctx0 = playContext.peek();
  const cur0 = currentId.peek();
  const rep0 = repeatMode.peek();
  toast('Removed from queue', undefined, {
    label: 'Undo',
    // The glow starts once the song is back, so a slow restore doesn't eat into it.
    run: () => void player.restore(it.track, undo).then(() => glowRow(glowScope(kind), it.track.id)),
    stale: () => playContext.value !== ctx0 || currentId.value !== cur0 || repeatMode.value !== rep0,
    ...(it.track.membersOnly && { membersOnly: true }),
  });
}

/** The glow's scope: "From the top" apart, as Played can show the same songs at the same places. */
const glowScope = (kind: Kind) => (kind === 'top' ? 'queue:top' : 'queue');

/** Offline, a row that can't play is dimmed, as in every list (TrackRow). */
const offClass = (t: Track) => (!online.value && !isSaved(t, savedOffline.value) ? ' off' : '');

/**
 * Now Playing → Queue: the whole list, top to bottom as it plays (Spotify's Queue). What played
 * comes first, folded under "[+] Played · N" (a tap on one plays from there), then the playing
 * track, marked as in every list, then Up next, each song under its own kind's heading (AP1),
 * one each time the kind changes: queued by you, the rest of the list ("Next from: <source>"),
 * autoplay ("Autoplay · similar to <seed>"); with Repeat all, then the next lap, under "From the
 * top" (a tap on one there starts it). Below the list you're in, the list on the way, under "On the
 * way", as many rows as fill Up next to WAY_FILL: to look at, and a tap starts it from there. Up and
 * Down move a track under its heading, and the last played one's Down past the playing track, to
 * hear it again; Remove (every row but the playing one and those on the way) offers Undo.
 */
export function UpNext() {
  const sec = upNextSections.value;
  const shuffle = shuffleOn.value;
  const ctx = playContext.value;
  const here = sec.runs.filter((r) => !r.way);
  const ahead = here.reduce((n, r) => n + r.items.length, 0);
  const way = sec.runs.flatMap((r) => (r.way ? r.items : [])).slice(0, Math.max(0, WAY_FILL - ahead));
  const total = ahead + way.length;
  const guardUntil = useRef(0);
  const guarded = () => performance.now() < guardUntil.current;
  const root = useRef<HTMLElement>(null);
  const refocus = useRef<Refocus | null>(null);
  // A move or removal re-renders the rows (keyed by place): focus goes back once they show it.
  useLayoutEffect(() => {
    const r = refocus.current;
    if (!r || !root.current) return;
    if (performance.now() > r.until || focusRow(root.current, r)) refocus.current = null;
  });
  /** If button `b` has focus (the keyboard, or a tap), keep focus on `r` after the change. */
  const keepFocus = (b: Element, r: Omit<Refocus, 'until'> | null) => {
    if (document.activeElement === b && r) refocus.current = { ...r, until: performance.now() + REFOCUS_MS };
  };

  const remove = (it: UpItem, kind: Kind) => {
    if (guarded()) return false;
    guardUntil.current = performance.now() + REMOVE_GUARD_MS;
    removeWithUndo(it, kind);
    return true;
  };
  // The row moves or goes, and a tap on it plays it: each shows its press first (afterPress).
  const move = (b: HTMLElement, it: UpItem, kind: Kind, to: UpItem, button: RowButton) =>
    afterPress(b, () => {
      if (guarded()) return;
      keepFocus(b, { id: it.track.id, kind, index: to.index, button });
      glowRow(glowScope(kind), it.track.id, to.index);
      void player.move(it.index, to.index, it.track.id);
    });

  // peek: the line moves only with the rows, which change with it (not every tick).
  const listStart = player.state.peek().listStart;
  /**
   * A heading's rows. Played ones too, whose last ↓ moves it past the playing track (`past`: the row
   * it then follows), to play next after anything queued by you: to hear it again. ↑ ↓ stay on their
   * side of the current list's start, as a heading ends where the list on the way starts (S7); the
   * songs you queued belong to no list.
   */
  const rows = (kind: Kind | 'way', items: UpItem[], past?: UpItem) =>
    items.map((it, k) => {
      const apart = (b?: UpItem) => !b || (kind !== 'queued' && b.index < listStart !== it.index < listStart);
      const down = items[k + 1] ?? past;
      return (
        <li
          // With the kind: Played and "From the top" can show one song at once.
          key={`${kind}:${it.track.id}:${it.index}`}
          class={'row' + (kind === 'list' ? '' : ` ${kind}`) + offClass(it.track) + (it === glowing?.item ? ' moved' : '')}
          data-testid={kind === 'played' ? 'upnext-played' : 'upnext-row'}
          data-track-id={it.track.id}
          data-index={it.index}
          data-section={kind}
          data-queued={kind === 'queued' ? 'true' : undefined}
        >
          <button
            class="row-main"
            // Offline and not saved: a screen reader hears it can't play, as the dimmed row shows.
            aria-disabled={offClass(it.track) ? true : undefined}
            {...longPress(it.track, kind === 'queued' ? it : null)}
            // A "From the top" row enters the next lap (the songs you queued and heard leave).
            onClick={(e) => afterPress(e.currentTarget, () => player.skipTo(it.index, it.track.id, kind === 'top'))}
            aria-label={`Play ${it.track.title}${{ played: ', played', queued: ', queued by you', list: '', autoplay: ', autoplay', top: ', from the top', way: ', on the way' }[kind]}`}
          >
            <RowBody track={it.track} />
          </button>
          {/* The list on the way only shows what's coming: it can't be reordered or removed from (S7, D15). */}
          {kind !== 'way' && (
            <div class="upnext-actions">
              {/* Reorder within each section. With shuffle on the order is random, so no arrows, but songs you queued keep theirs: shuffle never mixes them (rule 8). */}
              {!shuffle || kind === 'queued' ? (
                <>
                  <button
                    class="icon-btn"
                    aria-label={`Move ${it.track.title} up`}
                    disabled={apart(items[k - 1])}
                    onClick={(e) => move(e.currentTarget, it, kind, items[k - 1], 'up')}
                    data-role="up"
                    data-testid="upnext-up"
                  >
                    <Icon name="up" size={20} />
                  </button>
                  <button
                    class="icon-btn"
                    aria-label={`Move ${it.track.title} down`}
                    disabled={apart(down)}
                    onClick={(e) => down && move(e.currentTarget, it, down === past ? 'list' : kind, down, 'down')}
                    data-role="down"
                    data-testid="upnext-down"
                  >
                    <Icon name="down" size={20} />
                  </button>
                </>
              ) : null}
              <button
                class="icon-btn"
                aria-label={`Remove ${it.track.title} from queue`}
                onClick={(e) => {
                  const b = e.currentTarget;
                  const near = items[k + 1] ?? items[k - 1];
                  // The only row of its part: the next row with buttons, else the one before.
                  const rows = [...(root.current?.querySelectorAll<HTMLElement>('li[data-section]:not([data-section="current"], [data-section="way"])') ?? [])];
                  const at = rows.indexOf(b.closest('li')!);
                  const other = rows[at + 1] ?? rows[at - 1];
                  const to = near ? { id: near.track.id, kind } : other && { id: other.dataset.trackId!, kind: other.dataset.section as Kind };
                  afterPress(b, () => {
                    if (remove(it, kind)) keepFocus(b, to ? { ...to, index: null, button: 'remove', gone: [it.track.id, it.index] } : null);
                  });
                }}
                data-role="remove"
                data-testid="upnext-remove"
              >
                <Icon name="close" size={20} />
              </button>
            </div>
          )}
        </li>
      );
    });

  const titles = { queued: 'Queued by you', list: ctx?.label ? `Next from: ${ctx.label}` : 'Next from the list', autoplay: autoplayLabel.value };
  const repeat = repeatMode.value;
  const current = currentTrack.value;
  const played = previousTracks.value;
  const open = playedOpenFor.value === ctx;
  // The next lap: native may send it a moment after Repeat changes.
  const lap = repeat === 'all' ? lapTracks.value : [];
  const g = glow.value;
  const parts = g?.scope === 'queue' ? [open ? played : [], ...here.map((r) => r.items)] : g?.scope === 'queue:top' ? [lap] : null;
  const glowing = g && parts && movedRow(g, parts);
  return (
    <section ref={root} class="upnext" data-testid="up-next">
      <div class="section-head upnext-head">
        <h3 class="section-title upnext-heading" data-testid="upnext-title">
          Queue
          {(shuffle || repeat !== 'off') && (
            <>
              {' '}
              <span class="upnext-modes">
                {shuffle && <span>· Shuffled </span>}
                {repeat !== 'off' && <span>· {repeat === 'one' ? 'Repeat song' : 'Repeat queue'}</span>}
              </span>
            </>
          )}
        </h3>
        {total > 0 && <span class="dim small upnext-left">{upTo(total)} up next</span>}
      </div>
      {current && (
        <div class="upnext-save">
          <button class="link-btn" onClick={() => saveQueue([...played.map((u) => u.track), current, ...sec.runs.flatMap((r) => r.items.map((u) => u.track))])} data-testid="upnext-save">
            [Save queue as playlist]
          </button>
        </div>
      )}
      <ol class="list compact">
        {played.length > 0 && (
          <li class="upnext-fold">
            <button
              class="link-btn"
              aria-expanded={open}
              aria-label={`Played, ${played.length >= UP_NEXT_MAX ? `${UP_NEXT_MAX}+ tracks` : plural(played.length, 'track')}`}
              onClick={(e) => afterPress(e.currentTarget, () => (playedOpenFor.value = open ? undefined : ctx))}
              data-testid="upnext-played-fold"
            >
              Played · {upTo(played.length)}
            </button>
          </li>
        )}
        {/* peek: the index only matters with the rows, which change with it (not every tick). */}
        {open && rows('played', played, shuffle || !current ? undefined : { track: current, index: sec.queued.at(-1)?.index ?? player.state.peek().index })}
        {current && (
          <>
            <li class="upnext-label" data-testid="upnext-current-label" aria-hidden="true">
              Now playing
            </li>
            <li class={'row is-current' + (!online.value && !currentPlaysOffline.value ? ' off' : '')} data-testid="upnext-current" data-track-id={current.id} data-section="current">
              <div class="row-main" aria-current="true" {...longPress(current)}>
                <RowBody track={current} playing={isPlaying.value} />
              </div>
            </li>
          </>
        )}
        {here.map((r, k) => (
          <Fragment key={k}>
            <li class={'upnext-label' + (r.kind === 'autoplay' ? ' auto' : '')} data-testid={`upnext-${r.kind}-label`} aria-hidden="true">
              {titles[r.kind]}
            </li>
            {rows(r.kind, r.items)}
          </Fragment>
        ))}
        {way.length > 0 && (
          <>
            <li class="upnext-label" data-testid="upnext-way-label" aria-hidden="true">
              On the way
            </li>
            {rows('way', way)}
          </>
        )}
        {lap.length > 0 && (
          <>
            <li class="upnext-label" data-testid="upnext-top-label" aria-hidden="true">
              From the top
            </li>
            {rows('top', lap)}
          </>
        )}
      </ol>
      {/* A screen reader hears where the song went (moved, or put back by Undo), as the glow shows it. */}
      <p class="sr-only" aria-live="polite" data-testid="upnext-moved">
        {glowing ? `${g?.to == null ? 'Back at' : 'Moved to'} ${glowing.place} of ${glowing.of}` : ''}
      </p>
      {total === 0 && repeat !== 'all' && (
        <div class="dim small upnext-empty">{`${settings.value.autoplay ? 'Nothing queued.' : 'Autoplay is off.'} ⋯ → Add to queue plays a track next.`}</div>
      )}
    </section>
  );
}

/** The row the glow is on: the moved song where it is now (the copy nearest its target), with its place in its part. */
function movedRow(g: Glow, parts: UpItem[][]): { item: UpItem; place: number; of: number } | null {
  let best: { item: UpItem; place: number; of: number } | null = null;
  for (const part of parts)
    part.forEach((item, k) => {
      // Without a place (an Undo), the first copy.
      const far = (u: UpItem) => (g.to == null ? 0 : Math.abs(u.index - g.to));
      if (item.track.id === g.id && (!best || far(item) < far(best.item))) best = { item, place: k + 1, of: part.length };
    });
  return best;
}
