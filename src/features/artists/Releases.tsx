import { artistKey } from '../../data/artists';
import { SHELF_LABEL, type Release } from '../../data/ytmusic';
import { feedKey, feeds } from '../../stores/feed';
import type { ReleasesRef } from '../../ui/nav';
import { BackButton } from '../../ui/components/BackButton';
import { Screen } from '../../ui/components/Screen';
import { GlobalError, ReleaseGrid, releasesLoader } from '../../ui/components/Music';
import { EmptyState } from '../../ui/components/TrackList';
import { OfflineGate } from '../../ui/components/OfflineGate';
import { OFFLINE } from '../../core/offlineText';
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
        <BackButton testid="releases-back" label={`Back to ${artist}`} />
      }
    >
      <OfflineGate body={OFFLINE.global}>
        {snap.status === 'loading' ? (
          <GridSkeleton />
        ) : snap.status === 'error' && snap.error ? (
          <GlobalError error={snap.error} onRetry={() => feed.retry()} testid="releases-error" unavailable="Couldn't load this list." />
        ) : n ? (
          <>
            <ReleaseGrid releases={snap.items} artist={artist} kind={kind} />
            <div class="list-foot end">— end of tape —</div>
          </>
        ) : (
          <EmptyState title={`No ${title.toLowerCase()} found`}>Try again later.</EmptyState>
        )}
      </OfflineGate>
    </Screen>
  );
}
