/**
 * Share a track: Android's share sheet through @capacitor/share; in the browser
 * navigator.share, or else the link is copied. The link is the track on
 * music.youtube.com (content the owner asked for, not a UI label). A Jukebox track can
 * also share its Cyberspace post (P14), which sends people back to the Jukebox.
 */
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { isGlobal, type Track } from '../data/model';
import { toast } from '../store/toast';
import { isPostUrl } from './links';
import { TEST_HOOKS } from '../core/testHooks';

export function shareUrl(t: Pick<Track, 'ytId'>): string {
  return `https://music.youtube.com/watch?v=${encodeURIComponent(t.ytId)}`;
}

export function sharePayload(t: Pick<Track, 'ytId' | 'title' | 'artist'>): { title: string; text: string; url: string } {
  const label = t.artist ? `${t.title} — ${t.artist}` : t.title;
  return { title: label, text: label, url: shareUrl(t) };
}

declare global {
  interface Window {
    /** e2e only: replaces the native share call. */
    __cyberjukeShareStub?: (o: { title: string; text: string; url: string }) => Promise<void>;
  }
}

function cancelled(e: unknown): boolean {
  const m = String((e as { message?: unknown })?.message ?? e ?? '');
  return /cancel|abort/i.test(m) || (e as { name?: string })?.name === 'AbortError';
}

/** Only a Jukebox track has a post to share (Global ones have none). */
export function canSharePost(t: Track): boolean {
  return !isGlobal(t) && !!t.postUrl && isPostUrl(t.postUrl);
}

/** The Cyberspace post a Jukebox track was shared in. */
export function sharePostPayload(t: Pick<Track, 'postUrl' | 'postTitle' | 'title' | 'artist' | 'by'>): { title: string; text: string; url: string } {
  const what = t.artist ? `${t.title} — ${t.artist}` : t.title;
  const label = t.by ? `${what}, shared by @${t.by} on the Cyberspace Jukebox` : `${what} on the Cyberspace Jukebox`;
  return { title: t.postTitle || what, text: label, url: t.postUrl };
}

export function shareTrack(t: Track): Promise<void> {
  return share(sharePayload(t), "Couldn't share this track");
}

/** P14: share the track's Cyberspace post (Jukebox tracks only; see canSharePost). */
export function sharePost(t: Track): Promise<void> {
  if (!canSharePost(t)) return shareTrack(t);
  return share(sharePostPayload(t), "Couldn't share this post");
}

async function share(p: { title: string; text: string; url: string }, failed: string): Promise<void> {
  try {
    if (TEST_HOOKS && window.__cyberjukeShareStub) return await window.__cyberjukeShareStub(p);
    if (Capacitor.isNativePlatform()) {
      await Share.share({ ...p, dialogTitle: 'Share' });
      return;
    }
    if (typeof navigator.share === 'function') {
      await navigator.share(p);
      return;
    }
  } catch (e) {
    if (cancelled(e)) return;
  }
  try {
    await navigator.clipboard.writeText(p.url);
    toast('Link copied');
  } catch {
    toast(failed);
  }
}
