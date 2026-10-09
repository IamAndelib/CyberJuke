import { useRef } from 'preact/hooks';
import { currentId, player, playContext, upNextSections, type PlayerState, type UpItem, type UpNextKind } from '../../player';
import { toast } from '../../stores/toast';
import { Icon } from '../../ui/icons';
import { Art } from '../../ui/components/Art';

type Kind = UpNextKind;

/** After a removal the rows shift up: taps on the buttons column are ignored this long (M2). */
const REMOVE_GUARD_MS = 300;

/**
 * Now Playing → Up next, in three sections (AP1): queued by you, the rest of the list
 * ("Next from: <source>"), then autoplay ("Autoplay · similar to <seed>"). Up and Down
 * move a queued or list track within its section; Remove (every row) offers Undo.
 */
export function UpNext({ s }: { s: PlayerState }) {
  const sec = upNextSections.value;
  const ctx = playContext.value;
  const total = sec.queued.length + sec.list.length + sec.autoplay.length;
  const guardUntil = useRef(0);
  const guarded = () => performance.now() < guardUntil.current;

  const remove = (it: UpItem, kind: Kind, beforeId: string | null) => {
    if (guarded()) return;
    guardUntil.current = performance.now() + REMOVE_GUARD_MS;
    void player.remove(it.index, it.track.id);
    // Undo goes back next to the row that followed it (K3); it goes once a new list or
    // another track starts, when "back where it was" no longer means anything.
    const ctx0 = playContext.peek();
    const cur0 = currentId.peek();
    toast('Removed from queue', 4000, {
      label: 'Undo',
      run: () => void player.restore(it.track, kind, beforeId),
      stale: () => playContext.value !== ctx0 || currentId.value !== cur0,
      ...(it.track.membersOnly && { membersOnly: true }),
    });
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
              {/* Autoplay rows are suggestions: no reordering, only Remove. */}
              {!s.shuffle && kind !== 'autoplay' ? (
                <>
                  <button
                    class="icon-btn"
                    aria-label={`Move ${it.track.title} up`}
                    disabled={k === 0}
                    onClick={() => !guarded() && player.move(it.index, items[k - 1].index, it.track.id)}
                    data-testid="upnext-up"
                  >
                    <Icon name="up" size={20} />
                  </button>
                  <button
                    class="icon-btn"
                    aria-label={`Move ${it.track.title} down`}
                    disabled={k === items.length - 1}
                    onClick={() => !guarded() && player.move(it.index, items[k + 1].index, it.track.id)}
                    data-testid="upnext-down"
                  >
                    <Icon name="down" size={20} />
                  </button>
                </>
              ) : null}
              <button class="icon-btn" aria-label={`Remove ${it.track.title} from queue`} onClick={() => remove(it, kind, items[k + 1]?.track.id ?? null)} data-testid="upnext-remove">
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
    <section class="upnext" data-testid="up-next">
      <div class="section-head">
        <h3 class="section-title">Up next</h3>
        <span class="dim small">{s.shuffle ? 'Shuffled · turn shuffle off to reorder' : `${total} track${total === 1 ? '' : 's'}`}</span>
      </div>
      {total === 0 ? (
        <div class="dim small upnext-empty">{s.repeat === 'all' ? 'Queue repeats from the top.' : 'Nothing queued. ⋯ → Add to queue plays a track next.'}</div>
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
