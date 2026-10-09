import { useState } from 'preact/hooks';
import { smallArtworkUrl, type Track } from '../../data/model';
import { Icon, type IconName } from '../icons';

/**
 * The image of [Art] and Cover: [url] in the pixel frame (see .art in ui/ui.css), or a
 * [placeholder] icon when there is none or it fails to load.
 */
export function ArtFrame({ url, class: cls, placeholder = 'note', big }: { url?: string | null; class: string; placeholder?: IconName; big?: boolean }) {
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const failed = !url || failedFor === url;
  return (
    <div class={cls} aria-hidden="true">
      {failed ? (
        <div class="art-ph">
          <Icon name={placeholder} size={big ? 72 : 24} />
        </div>
      ) : (
        <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailedFor(url)} />
      )}
    </div>
  );
}

/**
 * YouTube thumbnail with the pixel treatment: cropped to a square from the 16:9
 * area inside hqdefault's 4:3 letterbox (or from mqdefault's 16:9 frame for small
 * art), grayscale + contrast, and one overlay with the theme-tinted duotone and the
 * dither/scanlines (see .art in ui/ui.css).
 */
export function Art({ track, size, class: cls }: { track: Track | null; size: 'sm' | 'fill'; class?: string }) {
  const full = track?.artworkUrl;
  const small = size === 'sm' && full ? smallArtworkUrl(full) : null;
  return <ArtFrame url={small ?? full} class={`art art-${size}${small ? ' art-wide' : ''}${cls ? ' ' + cls : ''}`} big={size === 'fill'} />;
}
