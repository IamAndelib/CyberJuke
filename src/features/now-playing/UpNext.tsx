import { useLayoutEffect, useRef } from 'preact/hooks';
import { currentId, player, playContext, repeatMode, shuffleOn, upNextSections, type UpItem, type UpNextKind } from '../../player';
import { toast } from '../../stores/toast';
import { Icon } from '../../ui/icons';
import { Art } from '../../ui/components/Art';

type Kind = UpNextKind;

/** After a removal the rows shift up: taps on the buttons column are ignored this long (M2). */
const REMOVE_GUARD_MS = 300;

/** A row's button had focus when it moved or went: where focus goes once Up next shows it. */
interface Refocus {
  /** The row: its track and section, at this place in the list (or anywhere: null). */
  id: string;
  kind: Kind;
  index: number | null;
  /** Its button: this one, else (disabled at the end of the section) the other arrow, else Remove. */
  button: string;
  /** Not before this row (the one removed: id and index) has gone. */
  gone?: [string, number];
  /** Given up after this (the player didn't follow). */
  until: number;
}
const REFOCUS_MS = 2000;

const rowAt = (id: string, index: number) => `[data-testid="upnext-row"][data-track-id="${CSS.escape(id)}"][data-index="${index}"]`;

function focusRow(root: HTMLElement, r: Refocus): boolean {
  if (r.gone && root.querySelector(rowAt(...r.gone))) return false;
  const index = r.index == null ? '' : `[data-index="${r.index}"]`;
  const row = root.querySelector(`[data-testid="upnext-row"][data-section="${r.kind}"][data-track-id="${CSS.escape(r.id)}"]${index}`);
  if (!row) return false;
  const pick = [r.button, r.button === 'upnext-up' ? 'upnext-down' : 'upnext-up', 'upnext-remove'];
  for (const b of pick) {
    const el = row.querySelector<HTMLButtonElement>(`[data-testid="${b}"]:not(:disabled)`);
    if (el) {
      el.focus({ preventScroll: true });
      return true;
    }
  }
  return false;
}

/**
 * Now Playing → Up next, in three sections (AP1): queued by you, the rest of the list
 * ("Next from: <source>"), then autoplay ("Autoplay · similar to <seed>"). Up and Down
 * move a queued or list track within its section; Remove (every row) offers Undo.
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
  /** If `e`'s button has focus (the keyboard, or a tap), keep focus on `r` after the change. */
  const keepFocus = (e: Event, r: Omit<Refocus, 'until'> | null) => {
    if (document.activeElement === e.currentTarget && r) refocus.current = { ...r, until: performance.now() + REFOCUS_MS };
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
  const move = (e: Event, it: UpItem, kind: Kind, to: UpItem, button: string) => {
    if (guarded()) return;
    keepFocus(e, { id: it.track.id, kind, index: to.index, button });
    void player.move(it.index, to.index, it.track.id);
  };

  const section = (kind: Kind, title: string, items: UpItem[]) =>
    items.length > 0 && (
      <>
        <li class={'upnext-label' + (kind === 'autoplay' ? ' auto' : '')} data-testid={`upnext-${kind}-label`} aria-hidden="true">
          {title}
        </li>
        {items.map((it, k) => (
          <li
            key={`${it.track.id}:${it.index}`}
            class={'row' + (kind === 'queued' ? ' queued' : '') + (kind === 'autoplay' ? ' autoplay' : '')}
            data-testid="upnext-row"
            data-track-id={it.track.id}
            data-index={it.index}
            data-section={kind}
            data-queued={kind === 'queued' ? 'true' : undefined}
          >
            <button
              class="row-main"
              onClick={() => player.skipTo(it.index, it.track.id)}
              aria-label={`Play ${it.track.title}${kind === 'queued' ? ', queued by you' : kind === 'autoplay' ? ', autoplay' : ''}`}
            >
              <div class="row-art">
                <Art track={it.track} size="sm" />
              </div>
              <div class="row-text">
                <div class="row-title">{it.track.title}</div>
                <div class="row-artist">{it.track.artist}</div>
              </div>
            </button>
            <div class="upnext-actions">
              {/* Reorder within each section (with shuffle on the order is random, so no arrows). */}
              {!shuffle ? (
                <>
                  <button
                    class="icon-btn"
                    aria-label={`Move ${it.track.title} up`}
                    disabled={k === 0}
                    onClick={(e) => move(e, it, kind, items[k - 1], 'upnext-up')}
                    data-testid="upnext-up"
                  >
                    <Icon name="up" size={20} />
                  </button>
                  <button
                    class="icon-btn"
                    aria-label={`Move ${it.track.title} down`}
                    disabled={k === items.length - 1}
                    onClick={(e) => move(e, it, kind, items[k + 1], 'upnext-down')}
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
                  const near = items[k + 1] ?? items[k - 1];
                  if (remove(it, kind, items[k + 1]?.track.id ?? null)) keepFocus(e, near ? { id: near.track.id, kind, index: null, button: 'upnext-remove', gone: [it.track.id, it.index] } : null);
                }}
                data-testid="upnext-remove"
              >
                <Icon name="close" size={20} />
              </button>
            </div>
          </li>
        ))}
      </>
    );

  const from = ctx?.label ? `Next from: ${ctx.label}` : 'Next from the list';
  const seedTitle = sec.seed?.title;
  return (
    <section ref={root} class="upnext" data-testid="up-next">
      <div class="section-head">
        <h3 class="section-title">Up next</h3>
        <span class="dim small">{shuffle ? 'Shuffled · turn shuffle off to reorder' : `${total} track${total === 1 ? '' : 's'}`}</span>
      </div>
      {total === 0 ? (
        <div class="dim small upnext-empty">{repeatMode.value === 'all' ? 'Queue repeats from the top.' : 'Nothing queued. ⋯ → Add to queue plays a track next.'}</div>
      ) : (
        <ol class="list compact">
          {section('queued', 'Queued by you', sec.queued)}
          {section('list', from, sec.list)}
          {section('autoplay', seedTitle ? `Autoplay · similar to ${seedTitle}` : 'Autoplay', sec.autoplay)}
        </ol>
      )}
    </section>
  );
}
