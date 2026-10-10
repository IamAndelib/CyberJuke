import { artistKey } from '../../data/artists';
import { SHELF_LABEL, musicErrorText, type MusicErrorCode, type Release } from '../../data/ytmusic';
import { feedKey, feeds } from '../../stores/feed';
import { Icon } from '../../ui/icons';
import { popPage, type ReleasesRef } from '../../ui/nav';
import { Screen } from '../../ui/components/Screen';
import { ReleaseGrid, releasesLoader } from '../../ui/components/Music';
import { EmptyState } from '../../ui/components/TrackList';
import { useFeed } from '../../ui/usePaged';

function GridSkeleton() {
  return (
    <ul class="release-grid" aria-hidden="true" data-testid="release-skeleton">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i}>
          <div class="art art-md skel-block" />
          <div class="skel-line" style={{ width: '80%', marginTop: '8px' }} />
        </li>
      ))}
    </ul>
  );
}

/** "See all" of one shelf on an artist page: every album (or live album, EP, single) as a grid. */
export function ReleasesPage({ release }: { release: ReleasesRef }) {
  const { kind, token, artist } = release;
  // A Retry reloads the artist page for fresh tokens; its cached feed then reloads too.
  const { feed, snap } = useFeed<Release, never>(
    `releases:${token}:${kind}`,
    releasesLoader(release, () => feeds.delete(feedKey.artistPage(artistKey(artist)))),
  );
  const title = SHELF_LABEL[kind];
  const n = snap.items.length;
  return (
    <Screen
      testid="screen-releases"
      title={title}
      subtitle={snap.status === 'ready' && n ? `${artist} · ${n}` : artist}
      scrollKey={`releases:${token}:${kind}`}
      left={
        <button class="icon-btn" aria-label={`Back to ${artist}`} onClick={popPage} data-testid="releases-back">
          <Icon name="back" />
        </button>
      }
    >
      {snap.status === 'loading' ? (
        <GridSkeleton />
      ) : snap.status === 'error' && snap.error ? (
        <div class="state compact" role="alert" data-testid="releases-error" data-code={snap.error.code}>
          <div class="state-glyph" aria-hidden="true">
            [ NO SIGNAL ]
          </div>
          <div class="state-body">
            {snap.error.code === 'NETWORK' || snap.error.code === 'BOT_CHECK'
              ? musicErrorText({ code: snap.error.code as MusicErrorCode })
              : "Couldn't load this list."}
          </div>
          <button class="btn" onClick={() => feed.retry()} data-testid="releases-retry">
            <Icon name="refresh" size={18} /> Retry
          </button>
        </div>
      ) : n ? (
        <>
          <ReleaseGrid releases={snap.items} artist={artist} kind={kind} />
          <div class="list-foot end">— end of tape —</div>
        </>
      ) : (
        <EmptyState title={`No ${title.toLowerCase()} found`}>Try again later.</EmptyState>
      )}
    </Screen>
  );
}
