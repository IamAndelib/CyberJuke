package io.github.iamandelib.cyberjuke.player

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
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
 *
 * Rejections carry code BOT_CHECK, NETWORK or UNAVAILABLE.
 *
 * All NewPipe work runs on a small background pool; lyrics run on their own single thread,
 * one request at a time. `next` is an opaque token for a
 * continuation kept native-side in a 50-entry LRU; an evicted token rejects UNAVAILABLE.
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
                    Log.w(TAG, "$what failed [$code]: $msg")
                    call.reject(msg, code)
                }
            }
        } catch (t: Throwable) { // RejectedExecutionException after destroy
            call.reject("music service stopped", "UNAVAILABLE")
        }
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

        /**
         * CI only (debuggable builds), each extra runs one background check and logs one line
         * the smoke test greps for (never anything the app depends on):
         * - `--es ci_music_search "<query>"`: one songs search, `CI search '<q>' -> N items`.
         * - `--es ci_artist "Queen"`: artist candidates,
         *   `CI artist 'Queen' -> N candidates: Queen=UC…; …`.
         * - `--es ci_lyrics "Queen|Bohemian Rhapsody|354"` (artist|title|durationSec, optional
         *   4th field ytId for the YouTube Music fallback):
         *   `CI lyrics '…' -> source=LRCLIB synced=N plain=N` or `-> not found`.
         * Failures log `CI <kind> '…' failed: <describe>` (BOT_CHECK: … for a bot check).
         */
        @JvmStatic
        fun maybeRunCiChecks(context: Context, intent: Intent?) {
            if (intent == null) return
            if ((context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) == 0) return
            val search = intent.getStringExtra(CI_EXTRA)?.trim()
            val artist = intent.getStringExtra(CI_ARTIST)?.trim()
            val lyrics = intent.getStringExtra(CI_LYRICS)?.trim()
            if (search.isNullOrEmpty() && artist.isNullOrEmpty() && lyrics.isNullOrEmpty()) return
            Lyrics.init(context.applicationContext)
            Thread({
                if (!search.isNullOrEmpty()) ciSearch(search)
                if (!artist.isNullOrEmpty()) ciArtist(artist)
                if (!lyrics.isNullOrEmpty()) ciLyrics(lyrics)
            }, "JukeMusicCi").start()
        }

        private fun ciSearch(q: String) {
            try {
                val r = YtMusic.search(q, YtMusic.Filter.SONGS)
                Log.i(TAG, "CI search '$q' -> ${r.items.size} items")
            } catch (t: Throwable) {
                Log.w(TAG, "CI search '$q' failed: ${YtMusic.describe(t)}")
            }
        }

        private fun ciArtist(name: String) {
            try {
                val items = YtMusic.artist(name)
                val list = items.take(8).joinToString("; ") { "${it.title}=${it.channelId}" }
                Log.i(TAG, "CI artist '$name' -> ${items.size} candidates: $list")
            } catch (t: Throwable) {
                Log.w(TAG, "CI artist '$name' failed: ${YtMusic.describe(t)}")
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
                Log.w(TAG, "CI lyrics '$spec' failed: [${YtMusic.errorCode(t)}] ${YtMusic.describe(t)}")
            }
        }
    }
}
