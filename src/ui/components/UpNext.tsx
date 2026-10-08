import { Fragment } from 'preact';
import { player, type PlayerState } from '../../player';
import { Icon } from '../icons';
import { Art } from './Art';

/** Now Playing → Up next: queued-by-you tracks first, then the rest of the list. */
export function UpNext({ s }: { s: PlayerState }) {
  const items = s.upNext;
  const canReorder = !s.shuffle;
  return (
    <section class="upnext" data-testid="up-next">
      <div class="section-head">
        <h3 class="section-title">Up next</h3>
        <span class="dim small">{s.shuffle ? 'Shuffled · turn shuffle off to reorder' : `${items.length} track${items.length === 1 ? '' : 's'}`}</span>
      </div>
      {items.length === 0 ? (
        <div class="dim small upnext-empty">{s.repeat === 'all' ? 'Queue repeats from the top.' : 'Nothing queued. ⋯ → Add to queue plays a track next.'}</div>
      ) : (
        <ol class="list compact">
          {items.map(({ track, index, queued }, k) => (
            <Fragment key={`${track.id}:${index}`}>
              {k === 0 && queued && (
                <li class="upnext-label" data-testid="upnext-queued-label" aria-hidden="true">
                  Queued by you
                </li>
              )}
              {!queued && k > 0 && items[k - 1].queued && (
                <li class="upnext-label" aria-hidden="true">
                  Next from the list
                </li>
              )}
              <li class={'row' + (queued ? ' queued' : '')} data-testid="upnext-row" data-queued={queued ? 'true' : undefined}>
                <button class="row-main" onClick={() => player.skipTo(index)} aria-label={`Play ${track.title}${queued ? ', queued by you' : ''}`}>
                  <div class="row-art">
                    <Art track={track} size="sm" />
                  </div>
                  <div class="row-text">
                    <div class="row-title">{track.title}</div>
                    <div class="row-artist">{track.artist}</div>
                  </div>
                </button>
                {canReorder && (
                  <>
                    <button
                      class="icon-btn sm"
                      aria-label={`Move ${track.title} up`}
                      disabled={k === 0}
                      onClick={() => player.move(index, items[k - 1].index)}
                      data-testid="upnext-up"
                    >
                      <Icon name="up" size={20} />
                    </button>
                    <button
                      class="icon-btn sm"
                      aria-label={`Move ${track.title} down`}
                      disabled={k === items.length - 1}
                      onClick={() => player.move(index, items[k + 1].index)}
                      data-testid="upnext-down"
                    >
                      <Icon name="down" size={20} />
                    </button>
                  </>
                )}
                <button class="icon-btn sm" aria-label={`Remove ${track.title} from queue`} onClick={() => player.remove(index)} data-testid="upnext-remove">
                  <Icon name="close" size={20} />
                </button>
              </li>
            </Fragment>
          ))}
        </ol>
      )}
    </section>
  );
}
