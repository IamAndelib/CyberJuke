/**
 * Share a track: Android's share sheet through @capacitor/share; in the browser
 * navigator.share, or else the link is copied. The link is the track on
 * music.youtube.com (content the owner asked for, not a UI label).
 */
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import type { Track } from '../data/model';
import { toast } from '../store/toast';
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

export async function shareTrack(t: Track): Promise<void> {
  const p = sharePayload(t);
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
    toast("Couldn't share this track");
  }
}
