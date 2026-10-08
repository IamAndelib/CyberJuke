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
 *     thumbnailUrl?: string; itemCount?: number }
 *   interface MusicPage { items: MusicItem[]; next?: string }
 *   search({ query, filter: 'songs' | 'albums' | 'artists' | 'playlists' }): Promise<MusicPage>
 *   more({ next }): Promise<MusicPage>
 *   playlist({ url }): Promise<{ title; subtitle; thumbnailUrl? } & MusicPage>
 *
 * Rejections carry code BOT_CHECK, NETWORK or UNAVAILABLE.
 *
 * All NewPipe work runs on a small background pool. `next` is an opaque token for a
 * continuation kept native-side in a 50-entry LRU; an evicted token rejects UNAVAILABLE.
 */
@CapacitorPlugin(name = "JukeMusic")
class MusicPlugin : Plugin() {

    private val executor: ExecutorService = Executors.newFixedThreadPool(2) { r ->
        Thread(r, "JukeMusic").apply { isDaemon = true }
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

    override fun handleOnDestroy() {
        executor.shutdownNow()
    }

    private fun run(call: PluginCall, what: String, work: () -> JSObject) {
        try {
            executor.execute {
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
        return o
    }

    companion object {
        private const val TAG = "CyberJukeMusic"
        private const val MAX_PAGES = 50
        const val CI_EXTRA = "ci_music_search"

        /**
         * CI only (debuggable builds): `--es ci_music_search "<query>"` runs one songs search
         * in the background and logs `CI search '<q>' -> N items` (or the failure), so the
         * smoke test can check the YouTube Music path without driving the web UI.
         */
        @JvmStatic
        fun maybeRunCiSearch(context: Context, intent: Intent?) {
            val q = intent?.getStringExtra(CI_EXTRA)?.trim()
            if (q.isNullOrEmpty()) return
            if ((context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) == 0) return
            Thread({
                try {
                    val r = YtMusic.search(q, YtMusic.Filter.SONGS)
                    Log.i(TAG, "CI search '$q' -> ${r.items.size} items")
                } catch (t: Throwable) {
                    Log.w(TAG, "CI search '$q' failed: ${YtMusic.describe(t)}")
                }
            }, "JukeMusicCi").start()
        }
    }
}
