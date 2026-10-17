# Changelog

## [Unreleased]

### The app
- Smoother playback on slow and unstable connections: the player now keeps about two minutes of music ready ahead (it used to be under one), notices a stalled connection sooner and retries it while the music plays on, and gets the next track ready after 10 seconds of the current one. It never loads more than the next track ahead, so skipping wastes little data.
- When the connection drops for good mid-song, playback pauses and the mini player and Now Playing say **Waiting for carrier…**. It carries on by itself once you're back, also on a weak Wi-Fi or mobile signal that never quite went away (it keeps trying for a few minutes, also with the screen locked). Meanwhile the button shows Pause: tap it and the music stays paused.
- **Waiting for carrier…** shows within a second of the music stalling with no connection, not only once the player has given up its retries; a stall that clears at once (a saved song starting, a network switch) shows nothing.
- Settings → Audio quality has a new default, **Auto**: the best quality the connection can keep up with. When playback stalls it steps down one notch, and after five minutes without a stall it tries a notch up again (waiting longer each time that stalls, up to 40 minutes), one notch at a time, only between tracks, never from lowest to highest at once. **High** (always the best audio) and **Low** (uses the least data) stay as before. If you had High, which was the default, you're now on Auto; Low stays Low.
- Offline, the app says plainly that music needs a connection: the top bar reads "no carrier · connect to play". Lists already on screen stay, their tracks fading to dim. Lists that can only lead to music (Home, genres, artists, albums, Search) and are opened while offline ask you to connect instead, in the middle of the screen; their **Redial** button checks again, and they fill in by themselves once you're online. A pull to refresh while offline says "No carrier. Connect, then refresh."
- Library stays as it is offline, its tracks dimmed. Tapping a dimmed track, Play, Shuffle or the Jukebox shuffle while offline says "No carrier. Connect to play." and leaves the player as it was.
- Switching between Wi-Fi and mobile data no longer flashes the app offline: a lost connection only counts once it has lasted a few seconds. Coming back counts at once.
- A message that takes more than one line fits its text, its lines evened out, instead of keeping an empty strip on the right. The offline bar and the "no carrier" screens even out their lines too.
- When the connection drops mid-track, the message says so ("Signal lost") instead of blaming the track, and whether it picks up by itself once you're back.
- A **listening cache** keeps the music you play, and the next track, on the phone, so the music keeps playing when the signal drops, and playing a song again costs no data. Settings → **Listening cache** sets how much it may keep: 128, 256 (the default) or 512 MB, and **Clear cache** empties it (a liked song playing then is saved again once it has loaded). It is kept with the app's data, so Android doesn't clear it when storage runs low. Nothing of it leaves the phone or goes into backups, and signing out removes the members-only tracks from it.
- Liked songs are saved in it too, so they play offline: a song you like is saved right away, and older likes one at a time, on Wi-Fi only, while the app is open or playing.
- A song saved on the phone plays from there on Auto and Low whatever quality it was saved at, also right after the app restarts; only High downloads it again when the saved copy is well below the best quality.
- A liked song whose save fails (the connection dropped) is tried again later by itself, waiting longer each time (30 seconds, then 1, 2 and 4 minutes), and is given up on after five failed tries until the app is next opened.
- Offline, the liked songs already saved play from any list (Liked, Recently played, Home, an album…), from the one you tap, and stand out bright; the rest is dimmed, and a liked song not saved yet says "Not saved yet. Needs a connection." The top bar reads "no carrier · your liked songs still play" and opens Liked, and anything else you try to play says so, with a button to Liked. With nothing saved yet, it asks you to connect, as before.
- Now Playing says when there's no connection, and offers your saved liked songs.
- Offline, a paused song resumes, saved or not, as long as some of it is already loaded: it plays that (and says "Signal lost" if it runs out). The song the app reopens on has nothing loaded yet, so offline it is dimmed like any other song that isn't saved, and Play says why instead of trying. Starting another song needs it saved.
- **Crossfade** (Settings → Crossfade): the end of a track blends into the next, over 3, 6 or 10 seconds, also on Repeat one: the old song fades all the way down as the new one rises, at an even overall loudness. Off by default. The song that is ending stays on screen, in the notification and on the lock screen until it has, then the next one shows. A skip changes tracks at once; a moment without connection, or a next track that isn't ready (one that can't play, or a very slow connection), changes them the usual way; short tracks get a shorter fade, and so does a song you drag into its last seconds (it fades over what is left).
- Settings → **Gapless playback** (on): the next track is readied while this one plays and they follow without a pause. Off, the next track loads only when this one ends, with a short pause between tracks, so a skip costs little data. Crossfade always readies the next track early, and with it on, two tracks of the same album go straight into each other instead of fading.
- Home's latest tracks show up sooner when the app opens: it asks Cyberspace for them while it starts, for about half the data, and brings genres and Most saved up to date just after. They're still always the newest posts, never a saved copy.

### Fixed
- A dropped or reset connection no longer skips good tracks, and a flapping connection no longer stops playback after five "failed" tracks: it waits and carries on instead.
- After a change of network (or of address on the same one), the next track's stream link is fetched again right away, and links the change didn't break are kept, so the next track starts sooner.
- A list that gets no answer from Cyberspace stops loading after 15 seconds and offers Retry, instead of showing placeholders forever.
- A list that failed during a network switch or behind a Wi-Fi login page reloads by itself when the connection is reported again and when you come back to the app.
- A request that fails outright is tried once more, a second later, before the list gives up.
- A listening cache that can't be read or written (the phone's storage full, a damaged file) no longer stops the track: it plays on from the network.
- Album art that couldn't load while offline loads once you're back online.
- When the next page of a list fails to load, the list waits for **Retry loading more** (or the connection coming back) instead of asking for it again and again, which wasted data and battery.
- With the app open and offline for longer than the new-tracks check interval, Home's check for new tracks waits its usual time between tries instead of trying again constantly, which used battery.
- Android's system log no longer records which track failed to play.
- While a track loads, the play button shows Pause (and its spinner), as it does while it plays, and a tap pauses it. It used to show Play, and a tap did nothing.

### Repository
- Eight "day in the life" tests run the browser build the way a day with the app goes: a commute through a tunnel, a Wi-Fi to mobile data handover, an album left playing, a sign-out while a liked song is still being saved, a night of Liked songs, an hour with the screen locked, slow browsing, and a café Wi-Fi with a login page. Hours pass on a faked clock, so each takes seconds.

## [1.1.2] - 2026-10-10

### Build
- The app builds with Debian's Node.js too, as F-Droid builds it (the Capacitor config is now plain JSON); the APK is the same either way. No changes in the app itself.

## [1.1.1] - 2026-10-10

### The app
- Members-only tracks you liked or played come back when you sign in again: to Liked where they were, and to Recently played (plays from its last 3 days). Signing out hides them; they wait on the phone, outside backups, apart for each account, so signing in with another account shows none of them and deletes none of them.
- No notification permission prompt on the first play: the playback controls don't need it.

### Fixed
- A scroll that starts on the seek bar no longer makes the thumb jump to your finger and back: the bar now waits to see which way the finger moves. Sideways drags the thumb, up or down scrolls Now Playing; a tap still seeks to that spot.
- Swiping Now Playing down closes it in one smooth motion, on from where your finger let go (it paused briefly, then sped off).
- A track whose stream server fails gets a fresh link instead of retrying the dead one, and an outage that keeps coming back stops retrying by itself after a few tries.
- Liked is no longer in Android's cloud backup (it can hold members-only tracks), like history.
- Global autoplay keeps going when a radio runs out of new songs.
- Lyrics for the next track wait until its length is known, so the right version is found.
- Messages stay clear of the search button and move above the mini player or a banner; a pull to refresh that fails says so; Genres says when the catalog couldn't load.
- Recently played plays each track once from the one you tap; play/pause shows at once.

## [1.1.0] - 2026-10-09

### The app
- Starring a genre or artist, or liking a track, responds at once (one tap used to redraw the whole grid or page around it).
- On the Genres and Artists tabs, a starred tile moves straight up into ★ Favourites (no copy stays in the grid); unstarring puts it back in its place.
- Adding shows a short "‹name› added to Favourites" / "Added to Liked songs" message without Undo; removing still offers Undo.
- One message at a time at the bottom: a new one replaces the last. Swipe it away left or right, or just carry on: it goes as soon as you touch or scroll anywhere else. A message without Undo lets your tap through to what's under it, and messages stay clear of back-to-top, the YouTube banner and, in Now Playing, Up next.
- Settings → Updates: installs from GitHub can check for a newer release (automatically at most once a day, or with Check now) and show it at the top of Settings and as a dot on the Settings tab. Installs from F-Droid update through F-Droid and never ask GitHub.
- Now Playing, the Library and Recently played do much less work while music plays (Now Playing redrew itself every second); a long history loads as you scroll.

### Fixed
- A scroll that starts on the seek bar scrolls Now Playing and no longer seeks.
- A quick second tap where a starred tile was no longer stars the tile that slid into its place.
- Genre and artist names fit their tiles on narrow phones instead of breaking mid-word.
- The A–Z letter while fast-scrolling skips a letter whose tiles are all in Favourites.
- Keyboard and screen-reader focus follows a starred tile, moved or removed Up next rows, and stays on the page after Clear history.
- After Android stopped the app: a tap on the music notification opens Now Playing even if the page had to reload; a list of over 500 tracks comes back at the right place; restored tracks are named (not "Unknown track"), keep whether they are members-only, and those go when signed out; Autoplay and audio quality apply to a media-key resume; Recently played records a track when it plays, not when the app reopens on it.
- Playback that YouTube paused comes back only where it was playing (not on the speaker once headphones are gone) and only while the app may start playback; Play pressed meanwhile keeps the phone awake for it; Pause, or a pause key, cancels it.

## [1.0.2] - 2026-10-09

### The app
- The app opens on what you were playing last time, paused at the same spot (with Up next, shuffle and repeat), even after it was swiped away, stopped by Android, force-stopped or crashed. Nothing loads until you press Play.
- Tapping the media notification (or the lock screen player) opens Now Playing.

### Fixed
- If Android reclaimed the memory of the app's web page while music played in the background (or that page crashed), Android killed the whole app and the music stopped. Now only the page reloads; playback goes on.
- Dragging the seek bar sought on every step of the drag, and the bar then stayed where it was let go, even after skipping to the next track. A drag now seeks once, when it ends, and the bar follows playback again.

### Repository
- The emulator smoke test also ends the page's renderer while music plays (as a system kill and as a crash) and checks that the app keeps playing, and force-stops the app and checks the last session comes back.

## [1.0.1] - 2026-10-09

The same app as 1.0.0, released so that F-Droid can ship it.

### Releases
- The release APK is signed without re-aligning it (`apksigner --alignment-preserved`): it is now exactly the unsigned build plus a signature, so F-Droid's own build of the tag matches it and F-Droid can ship the GitHub-signed APK. 1.0.0's signing had re-padded two uncompressed files, which broke that comparison.
- The Release workflow publishes nothing unless the signed APK passes that comparison (`apksigcopier compare`).

## [1.0.0] - 2026-10-09

The first stable release.

### The app
- The Cyberspace Jukebox as a music app: the latest tracks as an endless list, Most saved, "Shuffle the Jukebox", genres and artists with Play all and Shuffle, and search (Here, Jukebox and Global).
- Background playback through a native Media3 service, with notification, lock screen and headset controls; the queue keeps going with the screen off.
- Now Playing with synced lyrics and an Up next you can reorder; liked tracks and recently played, stored on the device.
- Optional sign-in for members-only shared tracks.
- Eight Cyberspace themes: Dark, Light, C64, VT320, Matrix, Crypt, Bubblegum and Brutalist. NSFW posts are hidden by default; high and low audio quality.

### Autoplay and queue
- **Autoplay:** when a list ends, similar songs keep playing. Jukebox tracks lead to Jukebox tracks picked by artist, genre and which artists the same posters share; Global tracks lead to that song's radio. A tap on Home, Most saved or search results starts a radio from that song; albums, Liked, history and genre pages play in order first. Settings → Autoplay turns it off.
- Tracks added with "Add to queue" stay next when you start another list.
- Up next shows three parts: queued by you, the rest of the list ("Next from …") and Autoplay, each reorderable with ▲/▼ (except with shuffle on). Now Playing says where playback came from.

### Interface
- Artist, genre and album pages open on the tab you're on; Back returns exactly where you were. Tapping the active tab scrolls to the top, then back to its first page.
- Undo for unlike, unfavourite, removing from Up next and clearing history; confirmation before clearing history and signing out.
- ★ marks favourite genres and artists (♥ is only for liked tracks); a genre or artist can be starred from its own page too.
- Now Playing: the ♥ sits beside the title and artist; long titles scroll in Now Playing and the mini player; long-press a row for its menu; swipe up on the mini player.
- Smoother pull to refresh, sheets and scrolling; bigger touch targets; no accidental text selection; a tap that stops a scroll no longer plays a track.
- Settings → Licenses lists every bundled library and opens their full license texts.
- Menus and confirmations hold the screen behind them: nothing scrolls or reacts under a menu, and focus returns to where it was.
- Search finds the music only (title, artist, genre), not who posted it. Recent searches (with Clear all); "Here" search on the Genres and Artists tabs; shorter Settings text; better contrast in the C64, Matrix, Crypt and Bubblegum themes.

### YouTube
- **"YouTube is limiting requests" happens far less and clears by itself.**
  - A new **IPv4** setting: **Auto** (the default), Always or Off. YouTube flags IPv6 addresses much more readily, so on Auto the app switches a network to IPv4 the moment YouTube refuses a request over IPv6, retries at once with no banner, and remembers that network (Wi-Fi and mobile data separately) for a day. The old "Prefer IPv4: on" becomes Always.
  - A refused request is retried once before anything is blocked; a refused stream gets one fresh link first.
  - When a block does happen, playback pauses instead of skipping track after track, and **resumes by itself** when a short wait is over (screen off too; not if you unplugged your headphones meanwhile). Waits are shorter (1, 3, 10, then 30 minutes) and relax again after half an hour without a block.
  - The same after a dropped connection: playback picks up again when the network is back.
  - Switching between Wi-Fi and mobile data, changing the IPv4 setting, or tapping **[Try now]** on the banner lifts a block at once.
  - A refused search, artist page, radio or lyrics lookup no longer stops the music: those features wait on their own.
  - Each song now costs YouTube 2 requests instead of 5 (the app asks only for what playback needs, and falls back to the full lookup if anything looks unexpected).
  - Settings shows a "Connection" line (IPv4 or IPv6, the last limit) to paste into bug reports.
- NewPipeExtractor follows the commit the NewPipe app ships.
- Stream links are reused until they expire; prefetching waits until a track has played for a while.

### Security and releases
- The preview is now a separate app, **CyberJuke Preview** (`io.github.iamandelib.cyberjuke.preview`), built like a release (R8, not debuggable) and signed with its own key kept only in repository secrets. It installs alongside CyberJuke and never shares its data. Uninstall the old debug-signed preview.
- The committed debug keystore is removed; debug builds use each machine's own debug key.
- Releases are built unsigned in a read-only job (no credentials, no install scripts, no caches) and signed with `apksigner` in a separate job in the protected `release` environment.
- Every GitHub Action is pinned to a commit SHA, each job has least-privilege permissions, and the Gradle wrapper and distribution are checksum-verified. A workflow generates Gradle dependency-verification metadata.
- The WebView's console logging and remote debugging are off in every build.
- The unused `google-services` Gradle plugin is removed.
- Other apps can only play, pause and skip: they can't change or read the queue. Sign-in data and members-only tracks stay out of Android backups and are removed on sign-out (and at startup when signed out).
- No plain-HTTP traffic; JitPack can only serve NewPipeExtractor's own artifacts.

### Quality
- ESLint (typescript-eslint and the hooks rules), and `npm run check` for typecheck, lint and unit tests.
- CI runs the Kotlin unit tests and the e2e suite (stubbed backends, three shards), and builds the preview.
- A daily canary checks playback, search, artist pages and lyrics against YouTube, and opens a `youtube-breakage` issue when parsing fails.
- Renovate keeps npm, Gradle, GitHub Actions and NewPipeExtractor up to date.

### F-Droid
- Literal `versionCode`/`versionName` (1.0.0 = 1000000); the Release workflow commits the bump before tagging.
- Fastlane store metadata: descriptions, icon, feature graphic, screenshots and per-version changelogs.
- Reproducible builds: no dependency-metadata block in the APK, and a byte-identical web build.
- A draft fdroiddata recipe in `docs/fdroid/`.

### Repository
- Web screenshots are no longer committed (a workflow renders them as an artifact); the README images are in `media/screenshots/`.
- New `CONTRIBUTING.md` and `SECURITY.md`; the README covers the architecture, privacy and data use, YouTube limitations and building.
