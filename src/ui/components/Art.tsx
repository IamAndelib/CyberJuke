import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { smallArtworkUrl, type Track } from '../../data/model';
import { Icon, type IconName } from '../icons';

/**
 * Bumped when the connection is back and when the app comes back to the foreground: images
 * that failed before then are asked for again (rows stay mounted across a reconnect, so a
 * failure would otherwise last as long as the row).
 */
export const artGen = signal(0);

/**
 * The image of [Art] and Cover: [url] in the pixel frame (see .art in ui/ui.css), or a
 * [placeholder] icon when there is none or it fails to load (until the next artGen).
 */
export function ArtFrame({ url, class: cls, placeholder = 'note', big }: { url?: string | null; class: string; placeholder?: IconName; big?: boolean }) {
  const [failedFor, setFailedFor] = useState<{ url: string; gen: number } | null>(null);
  // artGen is read only once this image has failed, so healthy frames never re-render for it.
  const failed = !url || (failedFor?.url === url && failedFor.gen === artGen.value);
  return (
    <div class={cls} aria-hidden="true">
      {failed ? (
        <div class="art-ph">
          <Icon name={placeholder} size={big ? 72 : 24} />
        </div>
      ) : (
        <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailedFor({ url, gen: artGen.peek() })} />
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
