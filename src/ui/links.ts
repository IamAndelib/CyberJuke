/**
 * Opening links outside the app. Only https URLs to known hosts open: a post link
 * comes from someone else's database, so `openPost` accepts Cyberspace posts only,
 * and `openExternal` the few sites the app itself links to.
 */
import { SITE_ORIGIN } from '../data/model';

/** Hosts `openExternal` may open (exact match). */
const EXTERNAL_HOSTS: ReadonlySet<string> = new Set([
  'beta.cyberspace.online',
  'cyberspace.online',
  'github.com',
  'www.gnu.org',
  'openfontlicense.org',
  'music.youtube.com',
]);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** A Cyberspace post (or page) URL: https://beta.cyberspace.online/… */
export function isPostUrl(url: string): boolean {
  const u = parse(url);
  return !!u && u.origin === SITE_ORIGIN && url.startsWith(SITE_ORIGIN + '/') && !u.username && !u.password;
}

export function isExternalUrl(url: string): boolean {
  const u = parse(url);
  return !!u && u.protocol === 'https:' && !u.port && !u.username && !u.password && EXTERNAL_HOSTS.has(u.hostname);
}

function open(url: string): void {
  window.open(url, '_blank', 'noopener');
}

/** Open a post on Cyberspace; anything else is ignored. Returns whether it opened. */
export function openPost(url: string): boolean {
  if (!url || !isPostUrl(url)) return false;
  open(url);
  return true;
}

/** Open one of the app's own outside links (sign-up, licenses, releases). */
export function openExternal(url: string): boolean {
  if (!isExternalUrl(url)) return false;
  open(url);
  return true;
}

/** The track on YouTube Music (the fallback while playback here is blocked). */
export function youtubeUrl(ytId: string): string {
  return `https://music.youtube.com/watch?v=${encodeURIComponent(ytId)}`;
}
