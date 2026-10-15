import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { online } from '../../core/network';
import { smallArtworkUrl, type Track } from '../../data/model';
import { Icon, type IconName } from '../icons';

/**
 * Bumped when the connection is back and when the app comes back to the foreground: images
 * that failed before then are asked for again (rows stay mounted across a reconnect, so a
 * failure would otherwise last as long as the row).
 */
export const artGen = signal(0);

/** How long an image that failed while the app counts as online waits for its one more try. */
export const ART_RETRY_MS = 1000;

/**
 * The image of [Art] and Cover: [url] in the pixel frame (see .art in ui/ui.css), or a
 * [placeholder] icon when there is none or it fails to load (until the next artGen).
 *
 * An image that fails while the app counts as online is asked for once more ART_RETRY_MS later,
 * as a Firestore request is (data/firestore.ts): when the connection comes back, Chromium fails the
 * requests caught in the network's switch (ERR_NETWORK_CHANGED), the artGen retries among them,
 * though the next request would load.
 */
export function ArtFrame({ url, class: cls, placeholder = 'note', big }: { url?: string | null; class: string; placeholder?: IconName; big?: boolean }) {
  const [failedFor, setFailedFor] = useState<{ url: string; gen: number } | null>(null);
  // The url given its one more try (one per artGen), and whether that try is still to come.
  const [retry, setRetry] = useState<{ url: string; gen: number; due: boolean } | null>(null);
  const waiting = !!url && retry?.url === url && retry.due;
  useEffect(() => {
    if (!waiting || !retry) return;
    const t = setTimeout(() => setRetry({ ...retry, due: false }), ART_RETRY_MS);
    return () => clearTimeout(t);
  }, [waiting, retry]);
  // artGen is read only once this image has failed, so healthy frames never re-render for it.
  const failed = !url || waiting || (failedFor?.url === url && failedFor.gen === artGen.value);
  const onError = () => {
    if (!url) return;
    const gen = artGen.peek();
    if (online.peek() && !(retry?.url === url && retry.gen === gen)) setRetry({ url, gen, due: true });
    else setFailedFor({ url, gen });
  };
  return (
    <div class={cls} aria-hidden="true">
      {failed ? (
        <div class="art-ph">
          <Icon name={placeholder} size={big ? 72 : 24} />
        </div>
      ) : (
        <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={onError} />
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
