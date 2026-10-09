# Testing a preview on your phone

Install **CyberJuke Preview** from <https://github.com/IamAndelib/CyberJuke/releases/tag/preview> (see [PUBLISHING.md, step 5](PUBLISHING.md#5-test-the-preview)). Tick each box as you go. Anything that's wrong or feels off is worth reporting.

**How to report:** what you did → what you expected → what happened. Add a screenshot or screen recording, and say whether you were on Wi-Fi or mobile data.

## Install
- [ ] It installs next to the regular CyberJuke (if you have it) and shows as **CyberJuke Preview**, with its icon.
- [ ] The first start shows Home with tracks within a few seconds.

## Playback
- [ ] A Home track plays. So do a genre track, an artist page track and a **Global** search result.
- [ ] With the screen off and the app in the background, music keeps playing and moves on to the next track.
- [ ] Notification and lock screen: play/pause, next and previous work, and they show the title and artwork. *(These changed: the lock screen no longer lists the queue.)*
- [ ] Unplugging headphones or disconnecting Bluetooth pauses playback.
- [ ] Switch between Wi-Fi and mobile data **during** a song: playback continues, or resumes by itself within a few seconds. No "YouTube is limiting requests" banner.
- [ ] Turn on airplane mode during a song until it stops, then off again: it carries on by itself.
- [ ] Start a Jukebox track, swipe the app away, and let it play past the list: autoplay keeps going. Reopen the app: Up next shows the autoplay tracks.
- [ ] Settings → Audio quality **Low**, then **High**: both play.
- [ ] Settings → **IPv4**: Always, then Off, then back to **Auto**: tracks play each time.
- [ ] On a phone or network that showed "YouTube is limiting requests" before: play for a while with IPv4 on **Auto**. The banner should rarely show; if it does, playback **resumes by itself** when a short countdown (1 or 3 min) ends, also with the screen off (keep the app in the background to check). Unplug your headphones during the countdown: it then stays paused.
- [ ] If the banner shows: tap **[Try now]**. It goes away; music resumes, or the banner comes back with a longer wait. Switching Wi-Fi ↔ mobile data also lifts it at once.
- [ ] Settings shows a **Connection** line under IPv4 (IPv4 or IPv6, and the last limit, if any).
- [ ] Pause a track right after starting it: it stays paused once it has loaded.
- [ ] Fling a long list and tap the search button (or a tab) while it is still moving: it opens on the first tap.

## Queue and autoplay
- [ ] Tap a track on Home. **Up next** shows similar songs under "Autoplay · similar to …" (same artist or genre feel).
- [ ] Play an album from an artist page. It plays in order, then autoplay continues after the last track.
- [ ] **Add to queue** two tracks, then start a different list. Your two queued tracks still play next.
- [ ] In Up next, **Remove** a track, then tap **Undo**. It comes back in the same place.
- [ ] Turn **Repeat** on: the autoplay section disappears. Turn it off: it comes back.
- [ ] Settings → **Autoplay** off: playback stops when the list ends.
- [ ] Let autoplay run for an hour or more: it keeps going without repeating the same songs.

## Browsing and gestures
- [ ] Open a genre page and tap ★ in the top bar: the genre shows under ★ Favourites on the Genres tab. Same on an artist page.
- [ ] Now Playing: the ♥ sits beside the title and artist; a long title scrolls without running under it.
- [ ] Open the ⋯ menu in Now Playing and drag on the menu and on the dark area above it: nothing behind it scrolls.
- [ ] Search for a poster's @name: nothing. Search for an artist or a song: found.
- [ ] Settings → Licenses → Full license texts opens and scrolls.
- [ ] Pull down on Home to refresh: smooth, with no jumping.
- [ ] Tap an artist or a genre (from Home, Search or Now Playing): it opens on the tab you're on, and **Back** returns exactly where you were, at the same scroll position.
- [ ] Tap the tab you're already on: it scrolls to the top. Tap again: it goes back to that tab's first page.
- [ ] Long-press a track row: its menu opens, and releasing your finger doesn't tap anything in the menu.
- [ ] Long titles scroll slowly in Now Playing and in the mini player.
- [ ] Long-pressing text (headers, titles) doesn't select it.
- [ ] Swipe up on the mini player: Now Playing opens. Swipe Now Playing down: it closes.
- [ ] Unlike a track, unfavourite (★) a genre or artist, and clear history: each one offers **Undo**. Clearing history and signing out ask you first.
- [ ] Liking a track or favouriting (★) a genre or artist shows a short "added" message with no Undo, and the star or heart fills at once, even with a long Artists list. On the Genres and Artists tabs the starred tile moves up into ★ Favourites straight away (not also left in the grid), and unstarring puts it back in its place.
- [ ] Swipe an **Undo** message at the bottom (e.g. after unliking) left, then another right: each one goes. A short drag springs back. A swipe that starts on **Undo** doesn't undo. Right after a swipe, one tap on ♥ or a ★ works (a fast flick too).
- [ ] Only one message shows at a time: star several genres quickly, and each new message replaces the last. Like a song in Now Playing, then scroll or tap anywhere else: the message goes at once. Its **Undo** still works.
- [ ] Settings → **Updates**: the automatic check is on; **Check now** says "Up to date (x.y.z)" or, when a newer release is out, shows it at the top of Settings with **Download**, and a dot on the Settings tab. Turning the toggle off stays off after a restart. Installed from F-Droid, the card only says updates come through F-Droid.
- [ ] The ⋯ menu of a liked song says **Unlike**; of any other song, **Like**. After **Next**, the Now Playing ♥ shows the new song's state.
- [ ] Every theme (Settings → Theme) is readable.

## Account (if you use Cyberspace sign-in)
- [ ] Sign in: tracks marked **[members]** appear.
- [ ] Close the app completely and reopen it: you're still signed in.
- [ ] Sign out: the [members] tracks disappear everywhere, including Liked and the queue.

## Rough conditions
- [ ] Airplane mode: an offline notice appears. Airplane mode off: lists load again by themselves.
- [ ] While music plays, swipe the app away from recent apps, then reopen it: Now Playing and Up next show the right tracks (no "Unknown track").
- [ ] Skip quickly through 10 tracks: no "YouTube is limiting requests" banner.
- [ ] If that banner ever appears, write down the time and your network. It's YouTube limiting your connection, and the app waits instead of hammering it.
