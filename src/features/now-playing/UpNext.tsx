import { signal } from '@preact/signals';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { autoplayLabel, currentId, currentTrack, isPlaying, player, playContext, previousTracks, repeatMode, shuffleOn, upNextSections, type PlayContext, type UpItem, type UpNextKind } from '../../player';
import type { Track } from '../../data/model';
import { online } from '../../core/network';
import { settings } from '../../stores/library';
import { isSaved, savedOffline } from '../../stores/savedOffline';
import { toast } from '../../stores/toast';
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
      </div>
    </>
  );
}

/** Offline, a row that can't play is dimmed, as in every list (TrackRow). */
const offClass = (t: Track) => (!online.value && !isSaved(t, savedOffline.value) ? ' off' : '');

/**
 * Now Playing → Queue: the whole list, top to bottom as it plays (Spotify's Queue). What played
 * comes first, folded under "[+] Played · N" (a tap on one plays from there), then the playing
 * track, marked as in every list, then three
 * sections (AP1): queued by you, the rest of the list ("Next from: <source>"), then autoplay
 * ("Autoplay · similar to <seed>"). Up and Down move a track within its section, and the last
 * played one's Down past the playing track, to hear it again; Remove (every row but the playing
 * one) offers Undo.
 */
export function UpNext() {
  const sec = upNextSections.value;
  const shuffle = shuffleOn.value;
  const ctx = playContext.value;
  const total = sec.queued.length + sec.list.length + sec.autoplay.length;
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

  const remove = (it: UpItem, kind: Kind, beforeId: string | null) => {
    if (guarded()) return false;
    guardUntil.current = performance.now() + REMOVE_GUARD_MS;
    void player.remove(it.index, it.track.id);
    // Undo goes back next to the row that followed it (K3); it goes once a new list or
    // another track starts, when "back where it was" no longer means anything.
    const ctx0 = playContext.peek();
    const cur0 = currentId.peek();
    toast('Removed from queue', undefined, {
      label: 'Undo',
      run: () => void player.restore(it.track, kind, beforeId),
      stale: () => playContext.value !== ctx0 || currentId.value !== cur0,
      ...(it.track.membersOnly && { membersOnly: true }),
    });
    return true;
  };
  // The row moves or goes, and a tap on it plays it: each shows its press first (afterPress).
  const move = (b: HTMLElement, it: UpItem, kind: Kind, to: UpItem, button: RowButton) =>
    afterPress(b, () => {
      if (guarded()) return;
      keepFocus(b, { id: it.track.id, kind, index: to.index, button });
      void player.move(it.index, to.index, it.track.id);
    });

  /**
   * A section's rows. Played ones too, whose last ↓ moves it past the playing track (`past`:
   * the row it then follows), to play next after anything queued by you: to hear it again.
   */
  const rows = (kind: Kind, items: UpItem[], past?: UpItem) =>
    items.map((it, k) => {
      const down = items[k + 1] ?? past;
      return (
        <li
          key={`${it.track.id}:${it.index}`}
          // Offline, a row that can't play is dimmed, as in every list (TrackRow).
          class={'row' + (kind === 'list' ? '' : ` ${kind}`) + offClass(it.track)}
          data-testid={kind === 'played' ? 'upnext-played' : 'upnext-row'}
          data-track-id={it.track.id}
          data-index={it.index}
          data-section={kind}
          data-queued={kind === 'queued' ? 'true' : undefined}
        >
          <button
            class="row-main"
            {...longPress(it.track)}
            onClick={(e) => afterPress(e.currentTarget, () => player.skipTo(it.index, it.track.id))}
            aria-label={`Play ${it.track.title}${{ played: ', played', queued: ', queued by you', list: '', autoplay: ', autoplay' }[kind]}`}
          >
            <RowBody track={it.track} />
          </button>
          <div class="upnext-actions">
            {/* Reorder within each section (with shuffle on the order is random, so no arrows). */}
            {!shuffle ? (
              <>
                <button
                  class="icon-btn"
                  aria-label={`Move ${it.track.title} up`}
                  disabled={k === 0}
                  onClick={(e) => move(e.currentTarget, it, kind, items[k - 1], 'up')}
                  data-role="up"
                  data-testid="upnext-up"
                >
                  <Icon name="up" size={20} />
                </button>
                <button
                  class="icon-btn"
                  aria-label={`Move ${it.track.title} down`}
                  disabled={!down}
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
                afterPress(b, () => {
                  if (remove(it, kind, items[k + 1]?.track.id ?? null)) keepFocus(b, near ? { id: near.track.id, kind, index: null, button: 'remove', gone: [it.track.id, it.index] } : null);
                });
              }}
              data-role="remove"
              data-testid="upnext-remove"
            >
              <Icon name="close" size={20} />
            </button>
          </div>
        </li>
      );
    });

  const section = (kind: Kind, title: string, items: UpItem[]) =>
    items.length > 0 && (
      <>
        <li class={'upnext-label' + (kind === 'autoplay' ? ' auto' : '')} data-testid={`upnext-${kind}-label`} aria-hidden="true">
          {title}
        </li>
        {rows(kind, items)}
      </>
    );

  const from = ctx?.label ? `Next from: ${ctx.label}` : 'Next from the list';
  const repeat = repeatMode.value;
  const current = currentTrack.value;
  const played = previousTracks.value;
  const open = playedOpenFor.value === ctx;
  return (
    <section ref={root} class="upnext" data-testid="up-next">
      <div class="section-head">
        <h3 class="section-title">Queue</h3>
        {shuffle && sec.list.length ? <span class="dim small">Shuffled · turn shuffle off to reorder</span> : total > 0 && <span class="dim small">{total >= UP_NEXT_MAX ? `${UP_NEXT_MAX}+` : total} up next</span>}
      </div>
      {repeat !== 'off' && (
        <div class="dim small upnext-empty" data-testid="upnext-repeat">
          {repeat === 'one' ? 'Repeating this song.' : 'Repeating the queue.'}
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
              Played · {played.length >= UP_NEXT_MAX ? `${UP_NEXT_MAX}+` : played.length}
            </button>
          </li>
        )}
        {open && rows('played', played, shuffle || !current ? undefined : { track: current, index: sec.queued.at(-1)?.index ?? player.state.value.index })}
        {current && (
          <>
            <li class="upnext-label" data-testid="upnext-current-label" aria-hidden="true">
              Now playing
            </li>
            <li class="row is-current" data-testid="upnext-current" data-track-id={current.id} data-section="current">
              <div class="row-main" aria-current="true" {...longPress(current)}>
                <RowBody track={current} playing={isPlaying.value} />
              </div>
            </li>
          </>
        )}
        {section('queued', 'Queued by you', sec.queued)}
        {section('list', from, sec.list)}
        {section('autoplay', autoplayLabel.value, sec.autoplay)}
      </ol>
      {total === 0 && repeat !== 'all' && (
        <div class="dim small upnext-empty">{`${settings.value.autoplay ? 'Nothing queued.' : 'Autoplay is off.'} ⋯ → Add to queue plays a track next.`}</div>
      )}
    </section>
  );
}
