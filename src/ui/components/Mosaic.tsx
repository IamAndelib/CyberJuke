import type { Track } from '../../data/model';
import { Icon } from '../icons';
import { Art } from './Art';

/**
 * A playlist's cover: the first four different song covers, 2×2 (YouTube Music's and
 * InnerTune's). With one to three, the first fills it; with none, an outlined tile with the
 * playlist icon. [size]: a row's (sm) or the playlist page's (lg).
 */
export function Mosaic({ tracks, size }: { tracks: readonly Track[]; size: 'sm' | 'lg' }) {
  const seen = new Set<string>();
  const covers: Track[] = [];
  for (const t of tracks) {
    if (!t.artworkUrl || seen.has(t.artworkUrl)) continue;
    seen.add(t.artworkUrl);
    covers.push(t);
    if (covers.length === 4) break;
  }
  if (!covers.length)
    return (
      <div class={`mosaic mosaic-${size} mosaic-empty`} aria-hidden="true">
        <Icon name="playlist" size={size === 'lg' ? 64 : 24} />
      </div>
    );
  if (covers.length < 4) return <Art track={covers[0]!} size={size === 'lg' ? 'fill' : 'sm'} class={`mosaic-${size}`} />;
  return (
    <div class={`mosaic mosaic-${size}`} aria-hidden="true">
      {covers.map((t) => (
        <Art key={t.id} track={t} size="fill" />
      ))}
    </div>
  );
}
