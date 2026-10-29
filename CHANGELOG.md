# Changelog

## [Unreleased]

### Changed
- Home's Shuffle follows the genre you picked: with rock selected it reads "Shuffle rock" and plays random rock songs; with All, the whole Jukebox as before. A shuffle now keeps going with more random songs from the same pool, instead of similar ones, while Autoplay is on.

### Fixed
- Signing in or out no longer reshuffles Home's genre chips for a few seconds while the Jukebox reloads: they change once, when the other list of songs has arrived, and members-only posts still go at once on sign-out.
- Turning shuffle off and on again on the phone shuffles anew, as the web does, instead of bringing back the same order as last time.
- Signed out, Home's genre chips of more than one word (alternative rock, hip hop, r&b…) show their songs again instead of "Nothing here yet".
- Repeat no longer empties Up next. After you tap a song on Home or in Search, **Repeat all** loops it together with the songs lined up after it, instead of playing the one song over and over, and **Next** moves on with **Repeat one** (from the last song back to the first, too). Autoplay adds no more while repeat is on, as before.

## [1.3.2] - 2026-10-29

### Fixed
- Opening a genre, an artist, an album or Search no longer shows bits of the screen you came from (its top bar, the stars, the scrollbar) over the new one or through it: pages open at once, as tabs and Back do, after the tile you tapped shows its press.
- Song pictures no longer flash as bright squares while they load in the dark themes; the box stays dark until the picture arrives.
- **[Cancel]** in menus and questions is just the word now: only it shows the press and closes them, not the whole bottom strip.

## [1.3.1] - 2026-10-28

### The app
- Back on Home now shows Android's back-to-home animation as you swipe (Android 13 and newer, where the phone shows it). The app goes to the background as before, and the music plays on. Back still closes menus, Now Playing and pages first.
- The music notification shows CyberJuke's jukebox in the status bar, instead of a plain music note.

### Fixed
- Every button shows its press on a quick tap now, as a slower tap does: the Settings icon, the Back arrows, the search button, the genre or artist in Now Playing, chips, rows, tiles, and buttons that change as you tap them (the Liked/Recent switch, shuffle, repeat, ♥, themes, switches); the tab bar stays as it was. Settings, the Back arrows and buttons that move or clear themselves away (**[Clear all]**, ✕, Up next's arrows and rows, a recent search, Retry) show it for a moment first; everything else changes straight away. With reduced motion on, the press still shows; only its movement is gone.
- Pressed text buttons and **[show]** beside the password have rounded corners like the rest, a pressed **[See all]** no longer hides its own text, and **[Undo]** on a message shows its press inside the message's frame instead of darkening it to its edge.
- Opening the app shows the jukebox on black until Home is ready, on every Android version, and then Home in your theme straight away: a light theme no longer flashes black first.
- The status bar and the navigation bar follow the theme: dark icons on the light themes, light ones on the dark themes, also after turning the phone or switching the phone's dark mode. The screen no longer shifts down just after the app opens, and there's no grey strip at the top or bottom.
- Search opens faster: it draws a screen of the Jukebox first and builds its index after it shows, not in the tap.
- The first visit to Genres or Artists draws a screen of tiles straight away; the rest follow a moment later.
- A genre page shows its songs as soon as it opens, from the ones already on the phone, instead of waiting for Cyberspace.
- **[Play]** on a list starts a moment sooner, and the shuffle and repeat buttons change as you tap them, not when the player answers.
- Tapping a song in a list responds sooner: autoplay picks the songs that follow once the app is idle, not in the tap.
- A post with several songs lists them in the post's own order everywhere, as on Cyberspace; Search and **[Play]** on a whole genre had them backwards.
- Search shows each new query's results from the top, not scrolled to where the last list was.

## [1.3.0] - 2026-10-27

### The app
- **Jukebox MP3s:** since Cyberspace 4.0 a Jukebox post can be an MP3 on latex.gg instead of a YouTube link. They show with their own cover and play like any other track (in lists, Liked, Recently played, autoplay and after a restart); before, the app left them out. MP3 posts made before you update show up in Search, genres, Most saved and Shuffle straight away. Sharing one shares its post. They are kept in the listening cache like any track, and a liked one is saved so it plays offline; one too big for the cache size you chose isn't saved. A YouTube slowdown doesn't stop them playing or being saved, and one latex.gg can't serve is skipped.
- **Signal Radio**, a new Radio tab: the curated stations Cyberspace's Jukebox plays as Signal Radio (hyphen8d's SIGNAL), in their YM and ZM bands. Tap a station to tune in: it plays all its tracks in a shuffle, then another, and on and on, and Now Playing shows "On Signal Radio · " and the station's name. The ⓘ button tells you what a station plays, and Search on the Radio tab looks through every station's tracks. The stations come with the app, so tuning in asks nothing of anyone but YouTube, for the music. A station isn't autoplay: it plays on with Autoplay off too. Offline, the stations dim like any track that can't play.
- **Settings** has moved from the tab bar to the top right of Home, so the tabs have more room. Back returns to Home, and the dot for a new release is on that button now.
- **Liked songs download on Wi-Fi only:** liked songs are saved for offline only on Wi-Fi now, including one you just liked; before, that one was downloaded on mobile data too. To save them on mobile data as well, turn on Settings → **Download using mobile data** (off by default). The song you're playing is still kept on the phone as it streams, on any network, which costs no extra data, so a liked song you play to the end still plays offline.
- On Android 12 and newer, your settings and recent searches go into your Google backup only when it is end-to-end encrypted, which needs a screen lock on the phone. Liked songs, history and your login were never in backups, and still aren't.

### Fixed
- A long track you haven't liked no longer pushes your saved liked songs out of the listening cache: when it doesn't fit beside them, it plays from the network instead.

## [1.2.0] - 2026-10-19

### The app
- **Listening cache:** the music you play and the next track are kept on the phone, so a drop in the signal doesn't stop the music and playing a song again costs no data. Settings → **Listening cache** sets how much it may keep (128, 256 or 512 MB; 256 by default), and **Clear cache** empties it, after asking. It is kept with the app's data, so Android doesn't clear it when storage runs low; nothing of it leaves the phone or goes into backups, and signing out removes the members-only tracks from it. When it can't be written (the phone's storage full), the music plays on from the network.
- **Liked songs play offline:** a song you like is saved right away, and older likes one at a time, on Wi-Fi, while the app is open or playing. A save cut short is tried again by itself, waiting longer each time. A saved song plays from the phone on Auto and Low whatever quality it was saved at; only High downloads it again when the saved copy is well below the best quality.
- **Offline**, the app says plainly that music needs a connection: the top bar reads "no carrier · connect to play", or "no carrier · your liked songs still play" (a tap opens Liked) once some are saved, and Now Playing says it too; a screen reader announces it. Lists already on screen stay: what can't play is dimmed, and saved liked songs stay bright and play from any list. Home, genres, artists, albums and Search opened offline ask you to connect, with **Redial**, and fill in by themselves once you're back. Anything else you try to play says why and leaves the player as it was; a paused song still resumes from what it has loaded.
- **Smoother playback on weak connections:** about two minutes of music is loaded ahead (it used to be under one), a stalled connection is noticed sooner and retried while the music plays on, and the next track's link is fetched after 10 seconds of the current one. Never more than the next track is loaded ahead, so skipping wastes little data.
- When the connection drops for good mid-song, playback pauses and, within a second, the mini player and Now Playing say **Waiting for carrier…**; the message says "Signal lost" instead of blaming the track. It carries on by itself once you're back, also on a weak signal that never quite went away and with the screen locked (it keeps trying for up to 9 minutes). Meanwhile the button shows Pause: tap it and the music stays paused.
- Settings → Audio quality has a new default, **Auto**: the best quality the connection can keep up with. Two stalls within 3 minutes step it down a notch; after five minutes without one it tries a notch up (waiting longer each time that fails, up to 40 minutes). It changes only between tracks. If you had High, the old default, you're now on Auto; Low stays Low.
- **Crossfade** (Settings → Crossfade, Off by default): the end of a track blends into the next over 3, 6 or 10 seconds, also on Repeat one, at an even overall loudness. The song that is ending stays on screen, in the notification and on the lock screen until it ends. A skip changes tracks at once; without a connection, or when the next track isn't ready, tracks change the usual way. Short tracks, and a song you drag into its last seconds, get a shorter fade.
- Settings → **Gapless playback** (on): the next track is readied while this one plays, and they follow without a pause; with Crossfade on, the tracks of an album you play from its page go straight into each other. Off, the next track loads when this one ends, with a short pause, so a skip costs little data (Crossfade still readies it early).
- Checking GitHub for a new release is now off until you turn it on (Settings → Updates), also if you had it on: it used to be on by default. Installs from F-Droid never check.
- Home's latest tracks show up sooner: the app asks Cyberspace for them while it starts, for about half the data, and brings genres and Most saved up to date just after. They're always the newest posts, never a saved copy.

### Fixed
- A dropped or reset connection no longer skips good tracks, and a flapping connection no longer stops playback after five "failed" tracks: it waits and carries on.
- After a change of network (or of address on the same one), the next track's stream link is fetched again right away, and links the change didn't break are kept, so the next track starts sooner.
- Switching between Wi-Fi and mobile data no longer flashes the app offline.
- A list that gets no answer from Cyberspace stops loading after 15 seconds and offers Retry. A request that fails outright is tried once more a second later, and a list that failed during a network switch or behind a Wi-Fi login page reloads by itself when the connection is back and when you return to the app.
- When the next page of a list fails to load, the list waits for **Retry loading more** (or the connection coming back) instead of asking for it again and again, which wasted data and battery.
- With the app open offline, Home's check for new tracks waits its usual time between tries instead of trying again constantly, which used battery.
- While a track loads, the play button shows Pause (and its spinner), and a tap pauses it. It used to show Play, and a tap did nothing.
- If Liked can't be read when the app opens (a storage hiccup), it is read again a little later and merged with what you liked meanwhile, as Recently played already was.
- Album art that couldn't load offline, or during a network switch, loads once you're back.
- A message that takes more than one line fits its text, its lines evened out, instead of keeping an empty strip on the right; one with a long name that has no spaces in it wraps instead of running off the screen, and so does an Up next heading.
- Screen readers read the line under the NSFW, Autoplay and Gapless switches in Settings along with the switch.
- Android's system log no longer records which track failed to play.

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
