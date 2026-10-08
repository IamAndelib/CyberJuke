package io.github.iamandelib.cyberjuke.bridge

import android.content.Context
import android.content.Intent
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import io.github.iamandelib.cyberjuke.lyrics.Lyrics
import io.github.iamandelib.cyberjuke.net.FailureKind
import io.github.iamandelib.cyberjuke.net.NetBlock
import io.github.iamandelib.cyberjuke.playback.PlayerBus
import io.github.iamandelib.cyberjuke.playback.SessionPolicy
import io.github.iamandelib.cyberjuke.playback.isDebuggable
import io.github.iamandelib.cyberjuke.yt.ArtistPage
import io.github.iamandelib.cyberjuke.yt.YtCompat
import io.github.iamandelib.cyberjuke.yt.YtMusic
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Capacitor bridge for YouTube Music data. Contract (TS side):
 *
 *   interface MusicItem { kind: 'song' | 'album' | 'artist' | 'playlist'; title: string;
 *     subtitle: string; url: string; ytId?: string; durationSec?: number;
 *     thumbnailUrl?: string; itemCount?: number;
 *     artistUrl?: string;   // songs + albums: first credited artist's channel URL
 *     channelId?: string }  // songs + albums: that artist's UC… id; artists: their own
 *   interface MusicPage { items: MusicItem[]; next?: string }
 *   search({ query, filter: 'songs' | 'albums' | 'artists' | 'playlists' }): Promise<MusicPage>
 *   more({ next }): Promise<MusicPage>
 *   playlist({ url }): Promise<{ title; subtitle; thumbnailUrl? } & MusicPage>
 *   artist({ name }): Promise<{ items: MusicItem[] }>   // MUSIC_ARTISTS candidates, channelId set
 *   lyrics({ ytId, title, artist, album?, durationSec? }): Promise<{ found: boolean;
 *     source?: string; synced?: { t: number (ms); text: string }[]; plain?: string;
 *     instrumental?: boolean }>   // not found resolves { found: false }
 *   interface Release { kind: 'album' | 'ep' | 'single' | 'live'; title: string; year?: string;
 *     url: string; thumbnailUrl?: string }   // url opens with playlist({ url })
 *   artistPage({ channelId }): Promise<{ name: string; thumbnailUrl?: string;
 *     topSongs: MusicItem[]; topSongsPlaylistUrl?: string; releases: Release[];
 *     more?: { albums?: string; singles?: string } }>   // opaque "See all" tokens
 *   artistReleases({ token }): Promise<{ releases: Release[] }>
 *   radio({ ytId, next? }): Promise<MusicPage>   // the song's radio (songs, without the seed);
 *     next pages with the returned `next`. Rejects BOT_CHECK during a back-off without a request.
 *
 * Rejections carry code BOT_CHECK, NETWORK or UNAVAILABLE.
 *
 * All NewPipe work runs on a small background pool; lyrics run on their own single thread,
 * one request at a time. `next` (and the artist page's `more` tokens) are opaque tokens
 * kept native-side in 50-entry LRUs; an evicted token rejects UNAVAILABLE.
 */
@CapacitorPlugin(name = "JukeMusic")
class MusicPlugin : Plugin() {

    private val executor: ExecutorService = Executors.newFixedThreadPool(2) { r ->
        Thread(r, "JukeMusic").apply { isDaemon = true }
    }

    private val lyricsExecutor: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "JukeLyrics").apply { isDaemon = true }
    }

    private val pages = object : LinkedHashMap<String, YtMusic.Continuation>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, YtMusic.Continuation>?) =
            size > MAX_PAGES
    }

    private val releaseTokens = object : LinkedHashMap<String, ArtistPage.More>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ArtistPage.More>?) =
            size > MAX_PAGES
    }

    @PluginMethod
    fun search(call: PluginCall) {
        val query = call.getString("query")?.trim()
        if (query.isNullOrEmpty()) {
            call.reject("query is required", "UNAVAILABLE"); return
        }
        val filter = YtMusic.Filter.parse(call.getString("filter"))
        if (filter == null) {
            call.reject("filter must be songs, albums, artists or playlists", "UNAVAILABLE"); return
        }
        run(call, "search '$query' ($filter)") { pageToJs(YtMusic.search(query, filter)) }
    }

    @PluginMethod
    fun more(call: PluginCall) {
        val token = call.getString("next")
        val cont = token?.let { synchronized(pages) { pages[it] } }
        if (cont == null) {
            call.reject("unknown or expired paging token", "UNAVAILABLE"); return
        }
        run(call, "more") { pageToJs(YtMusic.more(cont)) }
    }

    @PluginMethod
    fun playlist(call: PluginCall) {
        val url = call.getString("url")?.trim()
        if (url.isNullOrEmpty()) {
            call.reject("url is required", "UNAVAILABLE"); return
        }
        run(call, "playlist $url") {
            val p = YtMusic.playlist(url)
            val out = itemsToJs(p.items, p.next)
            out.put("title", p.title)
            out.put("subtitle", p.subtitle)
            p.thumbnailUrl?.let { out.put("thumbnailUrl", it) }
            out
        }
    }

    @PluginMethod
    fun artist(call: PluginCall) {
        val name = call.getString("name")?.trim()
        if (name.isNullOrEmpty()) {
            call.reject("name is required", "UNAVAILABLE"); return
        }
        run(call, "artist '$name'") { itemsToJs(YtMusic.artist(name), null) }
    }

    @PluginMethod
    fun artistPage(call: PluginCall) {
        val channelId = call.getString("channelId")?.trim()
        if (channelId.isNullOrEmpty()) {
            call.reject("channelId is required", "UNAVAILABLE"); return
        }
        run(call, "artistPage $channelId") {
            val a = YtMusic.artistPage(channelId)
            val out = JSObject()
            out.put("name", a.name)
            a.thumbnailUrl?.let { out.put("thumbnailUrl", it) }
            val songs = JSArray()
            for (it in a.topSongs) songs.put(itemToJs(it))
            out.put("topSongs", songs)
            a.topSongsPlaylistUrl?.let { out.put("topSongsPlaylistUrl", it) }
            out.put("releases", releasesToJs(a.releases))
            if (a.moreAlbums != null || a.moreSingles != null) {
                val more = JSObject()
                a.moreAlbums?.let { more.put("albums", releaseToken(it)) }
                a.moreSingles?.let { more.put("singles", releaseToken(it)) }
                out.put("more", more)
            }
            out
        }
    }

    @PluginMethod
    fun artistReleases(call: PluginCall) {
        val token = call.getString("token")
        val more = token?.let { synchronized(releaseTokens) { releaseTokens[it] } }
        if (more == null) {
            call.reject("unknown or expired releases token", "UNAVAILABLE"); return
        }
        run(call, "artistReleases ${more.browseId}") {
            val out = JSObject()
            out.put("releases", releasesToJs(YtMusic.artistReleases(more)))
            out
        }
    }

    /** YouTube Music's radio for a song (AP3); `next` is the continuation from the last page. */
    @PluginMethod
    fun radio(call: PluginCall) {
        val ytId = call.getString("ytId")?.trim()
        if (ytId == null || !SessionPolicy.isValidYtId(ytId)) {
            call.reject("ytId is required", "UNAVAILABLE"); return
        }
        val next = call.getString("next")?.takeIf { it.isNotBlank() }
        // Y1: no request at all while YouTube is backing us off.
        if (NetBlock.isBlocked()) {
            call.reject("BOT_CHECK: YouTube is limiting requests from this network", "BOT_CHECK"); return
        }
        run(call, "radio $ytId") {
            val page = YtMusic.radio(ytId, next)
            val arr = JSArray()
            for (it in page.items) arr.put(itemToJs(it))
            val out = JSObject()
            out.put("items", arr)
            page.next?.let { out.put("next", it) }
            out
        }
    }

    @PluginMethod
    fun lyrics(call: PluginCall) {
        val title = call.getString("title")?.trim()
        val artist = call.getString("artist")?.trim() ?: ""
        if (title.isNullOrEmpty()) {
            call.reject("title is required", "UNAVAILABLE"); return
        }
        val ytId = call.getString("ytId")?.trim()
        val album = call.getString("album")?.trim()?.takeIf { it.isNotEmpty() }
        val data = call.data
        val duration = if (data.has("durationSec") && !data.isNull("durationSec")) {
            (data.opt("durationSec") as? Number)?.toDouble()?.takeIf { it > 0 }
        } else {
            null
        }
        run(call, "lyrics '$artist - $title'", lyricsExecutor) {
            lyricsToJs(Lyrics.fetch(ytId, title, artist, album, duration))
        }
    }

    override fun load() {
        Lyrics.init(context)
    }

    override fun handleOnDestroy() {
        executor.shutdownNow()
        lyricsExecutor.shutdownNow()
    }

    private fun run(
        call: PluginCall,
        what: String,
        pool: ExecutorService = executor,
        work: () -> JSObject,
    ) {
        try {
            pool.execute {
                try {
                    call.resolve(work())
                } catch (t: Throwable) {
                    val code = YtMusic.errorCode(t)
                    val msg = YtMusic.describe(t)
                    // [what] holds the query / ids: info level only (R8 strips it in release).
                    Log.i(TAG, "$what failed [$code]: $msg")
                    Log.w(TAG, "${what.substringBefore(' ')} failed [$code]: ${t.javaClass.simpleName}")
                    reportFailure(t)
                    call.reject(msg, code)
                }
            }
        } catch (t: Throwable) { // RejectedExecutionException after destroy
            call.reject("music service stopped", "UNAVAILABLE")
        }
    }

    /**
     * A bot check or rate limit is network-wide: it starts the player's back-off too (Y1). A
     * parse failure means YouTube changed something (the JukePlayer `extractorBroken` event).
     */
    private fun reportFailure(t: Throwable) {
        val kind = YtCompat.classify(t)
        kind.blockReason?.let { NetBlock.trip(it) }
        if (kind == FailureKind.BROKEN) PlayerBus.emitExtractorBroken(YtMusic.describe(t))
    }

    private fun pageToJs(r: YtMusic.Result): JSObject = itemsToJs(r.items, r.next)

    private fun itemsToJs(items: List<YtMusic.Item>, next: YtMusic.Continuation?): JSObject {
        val arr = JSArray()
        for (it in items) arr.put(itemToJs(it))
        val out = JSObject()
        out.put("items", arr)
        if (next != null) {
            val token = UUID.randomUUID().toString()
            synchronized(pages) { pages[token] = next }
            out.put("next", token)
        }
        return out
    }

    private fun itemToJs(i: YtMusic.Item): JSObject {
        val o = JSObject()
        o.put("kind", i.kind)
        o.put("title", i.title)
        o.put("subtitle", i.subtitle)
        o.put("url", i.url)
        i.ytId?.let { o.put("ytId", it) }
        i.durationSec?.let { o.put("durationSec", it) }
        i.thumbnailUrl?.let { o.put("thumbnailUrl", it) }
        i.itemCount?.let { o.put("itemCount", it) }
        i.artistUrl?.let { o.put("artistUrl", it) }
        i.channelId?.let { o.put("channelId", it) }
        return o
    }

    private fun releaseToken(more: ArtistPage.More): String {
        val token = UUID.randomUUID().toString()
        synchronized(releaseTokens) { releaseTokens[token] = more }
        return token
    }

    private fun releasesToJs(releases: List<ArtistPage.Release>): JSArray {
        val arr = JSArray()
        for (r in releases) {
            val o = JSObject()
            o.put("kind", r.kind.js)
            o.put("title", r.title)
            r.year?.let { o.put("year", it) }
            o.put("url", r.url)
            r.thumbnailUrl?.let { o.put("thumbnailUrl", it) }
            arr.put(o)
        }
        return arr
    }

    private fun lyricsToJs(r: Lyrics.Result): JSObject {
        val o = JSObject()
        o.put("found", r.found)
        r.source?.let { o.put("source", it) }
        r.synced?.let { lines ->
            val arr = JSArray()
            for (l in lines) {
                val line = JSObject()
                line.put("t", l.t)
                line.put("text", l.text)
                arr.put(line)
            }
            o.put("synced", arr)
        }
        r.plain?.let { o.put("plain", it) }
        if (r.instrumental) o.put("instrumental", true)
        return o
    }

    companion object {
        private const val TAG = "CyberJukeMusic"
        private const val MAX_PAGES = 50
        const val CI_EXTRA = "ci_music_search"
        const val CI_ARTIST = "ci_artist"
        const val CI_LYRICS = "ci_lyrics"
        const val CI_ARTIST_PAGE = "ci_artist_page"
        const val CI_RADIO = "ci_radio"

        /**
         * CI only (debuggable builds), each extra runs one background check and logs one line
         * the smoke test greps for (never anything the app depends on):
         * - `--es ci_music_search "<query>"`: one songs search, `CI search '<q>' -> N items`.
         * - `--es ci_artist "Queen"`: artist candidates,
         *   `CI artist 'Queen' -> N candidates: Queen=UC…; …`.
         * - `--es ci_lyrics "Queen|Bohemian Rhapsody|354"` (artist|title|durationSec, optional
         *   4th field ytId for the YouTube Music fallback):
         *   `CI lyrics '…' -> source=LRCLIB synced=N plain=N` or `-> not found`.
         * - `--es ci_artist_page "UCEPMVbUzImPl4p8k4LkGevA"`: the artist page,
         *   `CI artistPage 'UC…' -> name='Queen' songs=N album=N live=N ep=N single=N
         *   more=albums,singles songsPlaylist=yes firstRelease=12tracks source=innertube`
         *   (firstRelease opens the first album through playlist(), as the web does).
         * - `--es ci_radio "fJ9rUzIMcZQ"`: the song's radio, two pages,
         *   `CI radio 'fJ9rUzIMcZQ' -> items=N more=yes page2=N first='Artist - Title'`.
         * Failures log `CI <kind> '…' failed: <describe>` (BOT_CHECK: … for a bot check).
         */
        @JvmStatic
        fun maybeRunCiChecks(context: Context, intent: Intent?) {
            if (intent == null) return
            if (!context.isDebuggable()) return
            val search = intent.getStringExtra(CI_EXTRA)?.trim()
            val artist = intent.getStringExtra(CI_ARTIST)?.trim()
            val lyrics = intent.getStringExtra(CI_LYRICS)?.trim()
            val artistPage = intent.getStringExtra(CI_ARTIST_PAGE)?.trim()
            val radio = intent.getStringExtra(CI_RADIO)?.trim()
            if (search.isNullOrEmpty() && artist.isNullOrEmpty() && lyrics.isNullOrEmpty() &&
                artistPage.isNullOrEmpty() && radio.isNullOrEmpty()
            ) return
            Lyrics.init(context.applicationContext)
            Thread({
                if (!search.isNullOrEmpty()) ciSearch(search)
                if (!artist.isNullOrEmpty()) ciArtist(artist)
                if (!lyrics.isNullOrEmpty()) ciLyrics(lyrics)
                if (!artistPage.isNullOrEmpty()) ciArtistPage(artistPage)
                if (!radio.isNullOrEmpty()) ciRadio(radio)
            }, "JukeMusicCi").start()
        }

        private fun ciRadio(ytId: String) {
            try {
                val r = YtMusic.radio(ytId)
                val page2 = r.next?.let { YtMusic.radio(ytId, it).items.size }
                val first = r.items.firstOrNull()?.let { "${it.subtitle} - ${it.title}" } ?: "none"
                Log.i(
                    TAG,
                    "CI radio '$ytId' -> items=${r.items.size} more=${if (r.next != null) "yes" else "no"} " +
                        "page2=${page2 ?: 0} first='$first'",
                )
            } catch (t: Throwable) {
                Log.i(TAG, "CI radio '$ytId' failed: [${YtMusic.errorCode(t)}] ${YtMusic.describe(t)}")
            }
        }

        private fun ciSearch(q: String) {
            try {
                val r = YtMusic.search(q, YtMusic.Filter.SONGS)
                Log.i(TAG, "CI search '$q' -> ${r.items.size} items")
            } catch (t: Throwable) {
                Log.i(TAG, "CI search '$q' failed: ${YtMusic.describe(t)}")
            }
        }

        private fun ciArtist(name: String) {
            try {
                val items = YtMusic.artist(name)
                val list = items.take(8).joinToString("; ") { "${it.title}=${it.channelId}" }
                Log.i(TAG, "CI artist '$name' -> ${items.size} candidates: $list")
            } catch (t: Throwable) {
                Log.i(TAG, "CI artist '$name' failed: ${YtMusic.describe(t)}")
            }
        }

        private fun ciArtistPage(channelId: String) {
            try {
                val a = YtMusic.artistPage(channelId)
                fun n(k: ArtistPage.Kind) = a.releases.count { it.kind == k }
                val more = listOfNotNull(
                    a.moreAlbums?.let { "albums" },
                    a.moreSingles?.let { "singles" },
                ).joinToString(",").ifEmpty { "none" }
                // Open the first album the way the web does (MPREb_ urls resolve lazily).
                val album = a.releases.firstOrNull { it.kind == ArtistPage.Kind.ALBUM } ?: a.releases.firstOrNull()
                val open = if (album == null) "none" else try {
                    val pl = YtMusic.playlist(album.url)
                    "${pl.items.size}tracks"
                } catch (t: Throwable) {
                    "failed[${YtMusic.errorCode(t)}]"
                }
                Log.i(
                    TAG,
                    "CI artistPage '$channelId' -> name='${a.name}' songs=${a.topSongs.size} " +
                        "album=${n(ArtistPage.Kind.ALBUM)} live=${n(ArtistPage.Kind.LIVE)} " +
                        "ep=${n(ArtistPage.Kind.EP)} single=${n(ArtistPage.Kind.SINGLE)} " +
                        "more=$more songsPlaylist=${if (a.topSongsPlaylistUrl != null) "yes" else "no"} " +
                        "firstRelease=$open source=${a.source}",
                )
            } catch (t: Throwable) {
                Log.i(TAG, "CI artistPage '$channelId' failed: [${YtMusic.errorCode(t)}] ${YtMusic.describe(t)}")
            }
        }

        private fun ciLyrics(spec: String) {
            val parts = spec.split("|").map { it.trim() }
            val artist = parts.getOrNull(0) ?: ""
            val title = parts.getOrNull(1) ?: ""
            val duration = parts.getOrNull(2)?.toDoubleOrNull()
            val ytId = parts.getOrNull(3)
            try {
                val r = Lyrics.fetch(ytId, title, artist, null, duration)
                if (r.found) {
                    Log.i(
                        TAG,
                        "CI lyrics '$spec' -> source=${r.source} synced=${r.synced?.size ?: 0} " +
                            "plain=${r.plain?.length ?: 0}" + if (r.instrumental) " instrumental" else "",
                    )
                } else {
                    Log.i(TAG, "CI lyrics '$spec' -> not found")
                }
            } catch (t: Throwable) {
                Log.i(TAG, "CI lyrics '$spec' failed: [${YtMusic.errorCode(t)}] ${YtMusic.describe(t)}")
            }
        }
    }
}
