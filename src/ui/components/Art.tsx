import { useState } from 'preact/hooks';
import { smallArtworkUrl, type Track } from '../../data/model';
import { Icon } from '../icons';

/**
 * YouTube thumbnail with the pixel treatment: cropped to a square from the 16:9
 * area inside hqdefault's 4:3 letterbox (or from mqdefault's 16:9 frame for small
 * art), grayscale + contrast, and one overlay with the theme-tinted duotone and the
 * dither/scanlines (see .art in app.css).
 */
export function Art({ track, size = 'md', class: cls }: { track: Track | null; size?: 'sm' | 'md' | 'lg' | 'fill'; class?: string }) {
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const full = track?.artworkUrl;
  const small = size === 'sm' && full ? smallArtworkUrl(full) : null;
  const url = small ?? full;
  const failed = !url || failedFor === url;
  return (
    <div class={`art art-${size}${small ? ' art-wide' : ''}${cls ? ' ' + cls : ''}`} aria-hidden="true">
      {failed ? (
        <div class="art-ph">
          <Icon name="note" size={size === 'lg' || size === 'fill' ? 72 : 24} />
        </div>
      ) : (
        <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailedFor(url!)} />
      )}
    </div>
  );
}
