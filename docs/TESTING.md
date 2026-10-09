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
- [ ] Settings → Audio quality **Low**, then **High**: both play.
- [ ] Settings → **Prefer IPv4** on: tracks play. Then turn it off again.

## Queue and autoplay
- [ ] Tap a track on Home. **Up next** shows similar songs under "Autoplay · similar to …" (same artist or genre feel).
- [ ] Play an album from an artist page. It plays in order, then autoplay continues after the last track.
- [ ] **Add to queue** two tracks, then start a different list. Your two queued tracks still play next.
- [ ] In Up next, **Remove** a track, then tap **Undo**. It comes back in the same place.
- [ ] Turn **Repeat** on: the autoplay section disappears. Turn it off: it comes back.
- [ ] Settings → **Autoplay** off: playback stops when the list ends.
- [ ] Let autoplay run for an hour or more: it keeps going without repeating the same songs.

## Browsing and gestures
- [ ] Pull down on Home to refresh: smooth, with no jumping.
- [ ] Tap an artist or a genre (from Home, Search or Now Playing): it opens on the tab you're on, and **Back** returns exactly where you were, at the same scroll position.
- [ ] Tap the tab you're already on: it scrolls to the top. Tap again: it goes back to that tab's first page.
- [ ] Long-press a track row: its menu opens, and releasing your finger doesn't tap anything in the menu.
- [ ] Long titles scroll slowly in Now Playing and in the mini player.
- [ ] Long-pressing text (headers, titles) doesn't select it.
- [ ] Swipe up on the mini player: Now Playing opens. Swipe Now Playing down: it closes.
- [ ] Unlike a track, unfavourite (★) a genre or artist, and clear history: each one offers **Undo**. Clearing history and signing out ask you first.
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
