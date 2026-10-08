<p align="center"><img src="media/banner.png" alt="CyberJuke" width="640"></p>

# CyberJuke

**The [Cyberspace](https://beta.cyberspace.online) Jukebox as a music-streaming app for Android.**

The Cyberspace Jukebox is where people on Cyberspace share the music they love, posted alongside what they write. It's a great way to find music you'd never have come across. CyberJuke turns it into a proper music app. It keeps Cyberspace's retro look and adds a music app's playback: a mini player, a Now Playing screen, an Up Next queue, and playback that continues with the screen off.

> **Unofficial.** CyberJuke is a fan-made app. It is not made, endorsed or supported by Cyberspace or its creator.

<p align="center">
  <img src="media/web-screenshots/02-home-playing.png" width="240" alt="Home">
  <img src="media/web-screenshots/04-now-playing.png" width="240" alt="Now Playing">
  <img src="media/web-screenshots/06-genres.png" width="240" alt="Genres">
</p>

## Features

- **Latest tracks** posted to the Jukebox, as an endless list.
- **Most saved**: the tracks people saved most on Cyberspace, this month or all time.
- **Search** every track on the Jukebox by title, artist, genre or @poster, with typo tolerance. With an empty query it lists the whole Jukebox, newest first. It works offline once the catalog is cached.
- **Shuffle the Jukebox**: one tap for a random mix from the whole Jukebox.
- **Genres**: browse every genre, heart your favorites to pin them to the top and to Home's filters, and play or shuffle any genre.
- **Artists**: every artist shared on the Jukebox, most-shared first, with hearts for a Favorite artists section. An artist page puts what Cyberspace people shared first, then the artist's top songs, albums, live albums, EPs and singles, taken from the artist's own YouTube Music page, each with "See all". Tap the artist or genre in Now Playing to jump to their page.
- **Sign in with Cyberspace** (optional): with your Cyberspace account, the Jukebox also shows the members-only shared tracks the site shows its members, marked `[members]`. See [Signing in](#signing-in).
- **Global search** (optional): a separate `[Global]` mode in Search for any song, album, artist or playlist beyond the Jukebox, powered by YouTube Music data. Global tracks can be played, liked and queued, but never show up on Home, Genres, Most saved or Shuffle.
- **Library**: liked tracks and recently played, stored on your phone.
- **Background playback**: the notification, lock screen and headset buttons all work, and the queue keeps going with the screen off.
- **Now Playing**: seek, shuffle, repeat, like, and an Up Next queue you can reorder.
- **"Posted by @user"** opens the original post on Cyberspace, so you can see what the poster wrote and reply.
- **Cyberspace themes**: Dark, Light, C64, VT320, Matrix, Crypt, Bubblegum and Brutalist.
- **NSFW** posts are hidden unless you turn them on.
- **Scroll memory**: every list keeps its place when you switch tabs or go back from a genre or artist, and a back-to-top button appears on long lists. On long lists, drag the scrollbar to jump; in A–Z order a big letter shows where you are while you drag.

## Install

1. Download the latest `CyberJuke-<version>.apk` from [Releases](../../releases).
2. Optional: check it against the `.sha256` file published with it: `sha256sum -c CyberJuke-<version>.apk.sha256`.
3. Open the APK on your phone and allow installing from this source when Android asks.

Requires Android 7.0 (API 24) or newer. Android 13+ asks for notification permission the first time you play something. The permission is only used for the playback controls.

CyberJuke is not on the Play Store and won't be (see [Caveats](#caveats)).

## How it works

| Part | What it does |
|---|---|
| **Track list** | Reads the same public post data the Cyberspace website shows on its Jukebox page, through `src/data/firestore.ts`. All data access goes through the `TrackSource` interface in `src/data/source.ts`, so it can be swapped for the [official Cyberspace API](https://api.cyberspace.online) by changing one file. |
| **Playback** | Every Jukebox track is a YouTube link. A native Android player resolves the audio stream with [NewPipeExtractor](https://github.com/TeamNewPipe/NewPipeExtractor) and plays it with Media3/ExoPlayer in a media session. The queue lives in that native service, which is what keeps music going with the screen off. |
| **Global search** | Artist pages and Global search use YouTube Music data, read on the phone through the `JukeMusic` plugin (`src/data/ytmusic.ts` on the web side): the artist's own page for top songs and the discography, NewPipeExtractor for search, albums and playlists. If the artist page can't be read, the app falls back to search filtered to the artist's channel. Results are cached for 10 minutes. |
| **Sign-in** | Optional. `src/data/auth.ts` signs in with Cyberspace's own login (Firebase Auth, email and password). Signed in, requests carry your login token and use the same query the site uses for members. |
| **UI** | Preact and TypeScript in a [Capacitor](https://capacitorjs.com) WebView, with the native player as a Capacitor plugin. |

The app doesn't need an account, track you or include analytics. The only network requests are for the track list, YouTube (to play audio), YouTube Music (only when you use Global search or open an artist page), artwork and, if you sign in, Cyberspace's login.

## Signing in

Signing in is optional. Without it, CyberJuke shows the Jukebox's public posts, exactly as before. With your Cyberspace account (Settings → Account → Sign in with Cyberspace) it also shows **members-only shared tracks**, the ones the site shows only when you're logged in. They're marked `[members]` in lists and in Now Playing. Their post links need a login on the site too.

- **Your password** goes only to Cyberspace's own login service (Google's Firebase Auth, the same one the website uses). CyberJuke never stores or logs it.
- **What is kept:** a login token (the refresh token), your user id and your @username, encrypted on the phone with an Android Keystore key. The short-lived access token stays in memory and is renewed before it expires. If the token can't be saved, you stay signed in until the app closes.
- **Sign out** (Settings → Account) deletes the token and clears the cached Jukebox data, including the members-only shared tracks. Signing in or out reloads the whole catalog.
- New accounts are made on [cyberspace.online](https://cyberspace.online/?signup=1); CyberJuke has no sign-up of its own.
- Signed in, requests stay as light as before: the same page sizes, cache times and refresh intervals.

## Caveats

- **Unofficial data access.** CyberJuke reads Cyberspace's public post data directly, because the official API needs supporter access. This can break if the site changes, and Cyberspace may ask for it to stop. Requests are kept light: 24 posts per page, a 5-minute cache, and no background polling. If the official API becomes available to CyberJuke, it will switch.
- **YouTube.** Playing audio without the official YouTube player goes against YouTube's Terms of Service. It also stops working whenever YouTube changes things, until NewPipeExtractor is updated. This is why CyberJuke is only distributed here and not on the Play Store. Some videos can't be played (removed, private, age-restricted or region-blocked). They are skipped automatically.

## Building

You need Node 22, JDK 21 and the Android SDK (compile SDK 36).

```bash
npm ci
npm run typecheck && npm test   # TypeScript and unit tests
npm run dev                      # browser preview (plays through a YouTube embed)
npm run e2e                      # Playwright tests against live data
npm run sync                     # build the web app and copy it into android/
cd android && ./gradlew assembleDebug
```

CI (`.github/workflows/ci.yml`) runs the web checks and builds the debug APK. It then runs an emulator smoke test (`scripts/ci-smoke.sh`) that checks playback reaches PLAYING and keeps playing in the background.

GitHub's runners are often blocked by YouTube's bot check, so the test also plays a test tone that is bundled only in debug builds. Signed releases are built by the manual `Release` workflow.

## Credits

- **[Cyberspace](https://beta.cyberspace.online)** and its creator **[@genghis_khan](https://beta.cyberspace.online/genghis_khan)**, for the site, its look and the Jukebox.
- **Everyone who posts music** to the Jukebox. Every track in the app is credited to its poster and links to their post.
- **[NewPipeExtractor](https://github.com/TeamNewPipe/NewPipeExtractor)** by Team NewPipe (GPL-3.0), for playback and the YouTube Music data behind Global search and "More by".
- Fonts: [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) and [Departure Mono](https://departuremono.com), both under the SIL Open Font License.

See [NOTICE.md](NOTICE.md) for all third-party components and their licenses.

## License

[GPL-3.0](LICENSE). The music belongs to its artists, and the posts belong to the people who wrote them.
