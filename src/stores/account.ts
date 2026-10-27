/**
 * The Cyberspace login (../data/auth) wired to the app's data: signing in or out drops
 * the source cache, the Jukebox feeds, the new-tracks baseline and both saved catalogs,
 * then fetches the whole catalog again for the new state. Signing out (and starting
 * signed out) also drops members-only tracks from Liked, history and the lyrics cache;
 * each account's members-only likes and plays come back when it signs in again. While
 * signed in, genre pages read the catalog (exact genre match), since the members query
 * has no genre filter.
 */
import { auth } from '../data/auth';
import { source } from '../data';
import { FirestoreError } from '../data/firestore';
import type { Track } from '../data/model';
import { feeds, JUKEBOX_FEED_PREFIXES } from './feed';
import { lyrics } from '../data/lyrics';
import { whenIdle } from '../core/idle';
import { catalog } from './catalog';
import { dropMembersOnly, returnMembersOnly } from './library';
import { freshness } from './newTracks';
import { dropToastActions, toast } from './toast';

/** One genre's tracks from the catalog (NSFW included; the source filters). */
async function catalogGenreTracks(genre: string): Promise<Track[]> {
  if (!catalog.all.value.length) await catalog.refresh();
  const all = catalog.all.value;
  const err = catalog.error.value;
  if (!all.length && err) throw new FirestoreError(err.message, 0, err.offline);
  return all.filter((t) => t.genre === genre);
}

source.genreTracks = catalogGenreTracks;

/** Forget everything loaded in the other sign-in state and load the catalog again. */
async function resetForSignIn(): Promise<void> {
  source.invalidateAll?.();
  feeds.deletePrefix(...JUKEBOX_FEED_PREFIXES);
  freshness.reset();
  await catalog.reset();
}

let started = false;

/**
 * Follow sign-ins and sign-outs (call once at startup, right after auth.restore(), which
 * may already be refreshing the login). Signed out at startup, members-only tracks are
 * dropped too: a backup restored onto a new phone, where the login didn't come along,
 * carries none. What this changes in Liked and history waits for `libraryRead` (they
 * are read alongside the first render), in the order it happened.
 */
export function startAccount(libraryRead: Promise<unknown> = Promise.resolve(), openSettings?: () => void): void {
  if (started) return;
  started = true;
  const afterRead = (fn: () => unknown) => void libraryRead.then(fn, fn);
  /** Who is signed in: at a sign-out, whose members-only likes are kept for later. */
  let uid = auth.state.value.user?.uid ?? null;
  if (!auth.signedIn()) {
    afterRead(() => dropMembersOnly());
    // It reads the whole lyrics cache: not while the app starts (a sign-out dropped them already).
    whenIdle(() => void lyrics.dropMembersOnly(), 1500, 300);
  } else if (uid) {
    const was = uid;
    afterRead(() => returnMembersOnly(was));
  }
  auth.onChange((signedIn, reason) => {
    if (!signedIn) {
      // Members-only posts leave the app after signing out (S8), and no Undo on screen
      // brings them back; only that account's likes and plays wait, out of sight, for its next sign-in.
      dropToastActions((a) => a.membersOnly === true);
      const was = uid;
      afterRead(() => dropMembersOnly(was));
      void lyrics.dropMembersOnly();
      uid = null;
    } else {
      uid = auth.state.value.user?.uid ?? null;
      const signedInAs = uid;
      if (signedInAs) afterRead(() => returnMembersOnly(signedInAs));
    }
    void resetForSignIn();
    if (reason === 'expired') {
      const text = 'Your Cyberspace login expired. Sign in again in Settings.';
      // Its button opens Settings (top right of Home; the app hands in how).
      if (openSettings) toast(text, undefined, { label: 'Settings', run: openSettings });
      else toast(text, 4000);
    }
  });
}
