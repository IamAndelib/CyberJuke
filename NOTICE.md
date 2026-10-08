# Notices

CyberJuke is an **unofficial** app. It is not affiliated with, endorsed by or supported by Cyberspace (beta.cyberspace.online) or its creator.

CyberJuke is copyright © 2026 IamAndelib and is licensed under the GNU General Public License v3.0 (see [LICENSE](LICENSE)).

## Content

- **Post data:** track titles, artists, genres, usernames and post links come from public posts on Cyberspace. They belong to the people who posted them.
- **Audio and artwork:** these come from YouTube and belong to their rights holders. CyberJuke neither hosts nor redistributes any audio.
- **Global search and "More by":** song, album, artist and playlist results come from YouTube Music and belong to their rights holders. They are fetched on the phone with NewPipeExtractor, cached briefly in memory, and never added to the Jukebox. The app labels this content "Global"; it is not affiliated with or endorsed by YouTube.
- **Cyberspace's look:** the app's visual style recreates Cyberspace's look (colours, monospace type, borders) in the app's own CSS. No Cyberspace logos, images or code are included.

## Third-party components

| Component | License | Use |
|---|---|---|
| [NewPipeExtractor](https://github.com/TeamNewPipe/NewPipeExtractor) | GPL-3.0 | Resolving YouTube audio streams; YouTube Music search, albums and playlists for Global search |
| [AndroidX Media3 / ExoPlayer](https://github.com/androidx/media) | Apache-2.0 | Playback, media session, notification |
| [OkHttp](https://github.com/square/okhttp) | Apache-2.0 | HTTP client |
| [Capacitor](https://github.com/ionic-team/capacitor) and its official plugins | MIT | Native app shell |
| [Preact](https://github.com/preactjs/preact), [@preact/signals](https://github.com/preactjs/signals) | MIT | UI |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | SIL OFL 1.1 | Font (`public/fonts/`, license in `public/fonts/OFL.txt`) |
| [Departure Mono](https://departuremono.com) | SIL OFL 1.1 | Font (`public/fonts/`, license in `public/fonts/OFL.txt`) |
| AndroidX libraries, Kotlin standard library | Apache-2.0 | Android runtime |

NewPipeExtractor's own dependencies (Rhino, jsoup, nanojson and others) keep their own licenses.
