/**
 * The Cyberspace login (../data/auth) wired to the app's data: signing in or out drops
 * the source cache, the Jukebox feeds, the new-tracks baseline and both saved catalogs,
 * then fetches the whole catalog again for the new state. Signing out (and starting
 * signed out) also drops members-only tracks from Liked, history and the lyrics cache;
 * that account's members-only likes come back when it signs in again. While signed in, genre pages
 * read the catalog (exact genre match), since the members query has no genre filter.
 */
import { auth } from '../data/auth';
import { source } from '../data';
import { FirestoreError, FirestoreSource } from '../data/firestore';
import type { Track } from '../data/model';
import { feeds, JUKEBOX_FEED_PREFIXES } from './feed';
import { lyrics } from '../data/lyrics';
import { catalog } from './catalog';
import { dropMembersOnly, returnMembersOnly } from './library';
import { freshness } from './newTracks';
import { dropToastActions, toast } from './toast';

const fs = source instanceof FirestoreSource ? source : null;

/** One genre's tracks from the catalog (NSFW included; the source filters). */
async function catalogGenreTracks(genre: string): Promise<Track[]> {
  if (!catalog.all.value.length) await catalog.refresh();
  const all = catalog.all.value;
  const err = catalog.error.value;
  if (!all.length && err) throw new FirestoreError(err.message, 0, err.offline);
  return all.filter((t) => t.genre === genre);
}

if (fs) fs.genreTracks = catalogGenreTracks;

/** Forget everything loaded in the other sign-in state and load the catalog again. */
async function resetForSignIn(): Promise<void> {
  fs?.invalidateAll();
  feeds.deletePrefix(...JUKEBOX_FEED_PREFIXES);
  freshness.reset();
  await catalog.reset();
}

let started = false;

/**
 * Follow sign-ins and sign-outs (call once at startup, after auth.restore() and
 * loadLibrary()). Signed out at startup, members-only tracks are dropped too: a
 * backup restored onto a new phone, where the login didn't come along, carries none.
 */
export function startAccount(): void {
  if (started) return;
  started = true;
  /** Who is signed in: at a sign-out, whose members-only likes are kept for later. */
  let uid = auth.state.value.user?.uid ?? null;
  if (!auth.signedIn()) {
    dropMembersOnly();
    void lyrics.dropMembersOnly();
  } else if (uid) {
    void returnMembersOnly(uid);
  }
  auth.onChange((signedIn, reason) => {
    if (!signedIn) {
      // Members-only posts leave the app after signing out (S8), and no Undo on screen
      // brings them back; only that account's likes wait, out of sight, for its next sign-in.
      dropToastActions((a) => a.membersOnly === true);
      dropMembersOnly(uid);
      void lyrics.dropMembersOnly();
      uid = null;
    } else {
      uid = auth.state.value.user?.uid ?? null;
      if (uid) void returnMembersOnly(uid);
    }
    void resetForSignIn();
    if (reason === 'expired') toast('Your Cyberspace login expired. Sign in again in Settings.', 4000);
  });
}
