package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.net.Family
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future

/**
 * Pure helpers behind [StreamResolver]: stream URL expiry (Y3), the memory-only LRU (Y4),
 * latest-only prefetching and the prefetch timing rule. No Android types (StreamCacheTest).
 */
internal object StreamUrls {
    /** Re-resolve this long before googlevideo's own `expire`. */
    const val EXPIRY_MARGIN_MS = 30L * 60L * 1000L

    /** Used when the URL carries no `expire` parameter. */
    const val FALLBACK_TTL_MS = 60L * 60L * 1000L

    private val EXPIRE = Regex("""[?&/]expire[=/](\d{9,11})(?:[&/]|$)""")
    private val ITAG = Regex("""[?&/]itag[=/](\d{1,4})(?:[&/]|$)""")

    /** googlevideo's `expire` (epoch seconds) as epoch ms, or null. */
    fun expireMs(url: String): Long? = EXPIRE.find(url)?.groupValues?.get(1)?.toLongOrNull()?.times(1000L)

    fun itag(url: String): Int? = ITAG.find(url)?.groupValues?.get(1)?.toIntOrNull()

    private val CLEN = Regex("""[?&/]clen[=/](\d{1,12})(?:[&/]|$)""")

    /** The file's length in bytes (googlevideo's `clen`), or null when the URL doesn't say. */
    fun clen(url: String): Long? = CLEN.find(url)?.groupValues?.get(1)?.toLongOrNull()?.takeIf { it > 0 }

    private val IP = Regex("""[?&/]ip[=/]([0-9A-Fa-f.:%]{2,64})(?:[&/]|$)""")

    /**
     * True if the URL is bound to an IPv6 address (googlevideo's `ip` parameter, URL-encoded
     * colons included), false for IPv4, null if it doesn't say.
     */
    fun boundToIpv6(url: String): Boolean? {
        val ip = IP.find(url)?.groupValues?.get(1) ?: return null
        return ip.contains(':') || ip.contains("%3A", ignoreCase = true)
    }

    /** The address family the URL is bound to ([boundToIpv6]), or null if it doesn't say. */
    fun familyOf(url: String): Family? = boundToIpv6(url)?.let { if (it) Family.IPV6 else Family.IPV4 }

    /** Until when a URL resolved at [resolvedAtMs] may be served from the cache. */
    fun cacheUntil(url: String, resolvedAtMs: Long): Long =
        expireMs(url)?.let { it - EXPIRY_MARGIN_MS } ?: (resolvedAtMs + FALLBACK_TTL_MS)

    /** True once googlevideo itself would reject the URL as expired. */
    fun isExpired(url: String, resolvedAtMs: Long, now: Long): Boolean {
        val expire = expireMs(url) ?: (resolvedAtMs + 6L * FALLBACK_TTL_MS)
        return now >= expire
    }
}

/** googlevideo request details, pure (StreamCacheTest). */
internal object YtUrls {
    /**
     * The `rn` request counter goes on progressive (query-style) `/videoplayback?...` URLs only,
     * never on path-style ones (HLS segments `/videoplayback/id/.../file/seg.ts`) and never twice;
     * NewPipe's HLS data source turns it off too (M3).
     */
    fun wantsRn(url: String): Boolean {
        val q = url.indexOf('?')
        if (q < 0) return false
        val path = url.substring(0, q).substringAfter("://").substringAfter('/', "")
        if (path != "videoplayback") return false
        val query = url.substring(q + 1)
        return query.split('&').none { it.startsWith("rn=") }
    }
}

/** Small access-ordered LRU with a per-entry deadline; thread-safe. */
internal class TtlLru<K, V>(private val maxEntries: Int) {
    private class Entry<V>(val value: V, val until: Long)

    private val map = object : LinkedHashMap<K, Entry<V>>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<K, Entry<V>>?) = size > maxEntries
    }

    @Synchronized
    fun get(key: K, now: Long): V? {
        val e = map[key] ?: return null
        if (now >= e.until) {
            map.remove(key)
            return null
        }
        return e.value
    }

    @Synchronized
    fun put(key: K, value: V, until: Long) {
        map[key] = Entry(value, until)
    }

    @Synchronized
    fun removeIf(pred: (K) -> Boolean) {
        map.keys.removeAll(pred)
    }

    /** Drops the entries whose value matches [pred] (expired or not). */
    @Synchronized
    fun removeValuesIf(pred: (V) -> Boolean) {
        map.values.removeAll { pred(it.value) }
    }

    @Synchronized
    fun clear() = map.clear()

    /** Tests only. */
    @Synchronized
    fun size(): Int = map.size
}

internal data class ResolvedStream(
    val ytId: String,
    val url: String,
    val headers: Map<String, String>,
    val description: String,
    val resolvedAtMs: Long,
    val itag: Int,
    /** [io.github.iamandelib.cyberjuke.net.NetEpoch.generation] when the extraction started: older ones are bound to an old IP. */
    val netGen: Int = 0,
    /** The video's quality ladder ([QualityLadder]) as bitrates, best first; empty for a fallback stream. */
    val ladderBps: List<Int> = emptyList(),
    /** An audio-only format: kept in the listening cache (a muxed fallback, with video, isn't). */
    val audioOnly: Boolean = false,
)

/**
 * [StreamResolver]'s URL cache (memory only, Y4): each video's streams by rung of its quality
 * ladder, and by itag. Every rung of an extraction goes in, so Auto steps between tracks without
 * another extraction. Thread-safe. Pure (StreamCacheTest).
 */
internal class StreamUrlCache(maxEntries: Int) {
    private val lru = TtlLru<String, ResolvedStream>(maxEntries)

    private fun rungKey(ytId: String, rung: Int) = if (rung == QualityLadder.LOWEST) "$ytId|low" else "$ytId|r$rung"

    private fun itagKey(ytId: String, itag: Int) = "$ytId|i$itag"

    /**
     * The stream to serve for [ytId] at [rung] (a rung past the video's ladder is its bottom
     * one), or null. With [keepItag] only that format will do (a resume, or a track kept in its
     * format through an outage, [StreamResolver.keepFormat]): a rung of another itag is passed over.
     */
    fun get(ytId: String, rung: Int, keepItag: Int?, now: Long): ResolvedStream? {
        val byRung = lru.get(rungKey(ytId, rung), now)
            ?: lru.get(rungKey(ytId, QualityLadder.LOWEST), now)?.takeIf { rung >= it.ladderBps.size }
        if (keepItag == null) return byRung
        return byRung?.takeIf { it.itag == keepItag } ?: lru.get(itagKey(ytId, keepItag), now)
    }

    /**
     * One extraction of [ytId]: [served], the stream handed out, and [rungs], the ladder's
     * streams best first (null where one may not be served). Without a ladder, [fallback] is what
     * every rung gets.
     */
    fun putExtraction(ytId: String, served: ResolvedStream, rungs: List<ResolvedStream?>, fallback: ResolvedStream?) {
        put(itagKey(ytId, served.itag), served)
        if (rungs.isEmpty()) {
            fallback?.let { put(rungKey(ytId, QualityLadder.LOWEST), it) }
            return
        }
        rungs.forEachIndexed { i, s ->
            if (s == null) return@forEachIndexed
            put(rungKey(ytId, i), s)
            if (i == rungs.lastIndex) put(rungKey(ytId, QualityLadder.LOWEST), s)
        }
    }

    private fun put(key: String, s: ResolvedStream) = lru.put(key, s, StreamUrls.cacheUntil(s.url, s.resolvedAtMs))

    /** Drops every stream of [ytId] (expired or rejected). */
    fun removeVideo(ytId: String) = lru.removeIf { it.startsWith("$ytId|") }

    /** Drops the streams whose URL is bound to one of [families] ([StreamUrls.familyOf]). */
    fun dropBoundTo(families: Set<Family>) {
        if (families.isEmpty()) return
        lru.removeValuesIf { s -> StreamUrls.familyOf(s.url)?.let { it in families } == true }
    }

    fun clear() = lru.clear()
}

/**
 * Runs at most one background task, the latest: submitting a new key cancels the previous task
 * if it has not started yet. A task already running is left to finish (not interrupted: it may
 * be an extraction a playing item is waiting on). Submitting the key that is already pending or
 * running is a no-op.
 */
internal class LatestTaskRunner(private val executor: ExecutorService) {
    private var future: Future<*>? = null
    private var key: String? = null

    @Synchronized
    fun submit(key: String, task: () -> Unit): Boolean {
        val f = future
        if (f != null && !f.isDone && this.key == key) return false
        f?.cancel(false)
        this.key = key
        future = executor.submit { task() }
        return true
    }

    @Synchronized
    fun cancel() {
        future?.cancel(false)
        future = null
        key = null
    }

    /** Tests only. */
    @Synchronized
    fun pendingKey(): String? = key?.takeIf { future?.isDone == false }
}

/**
 * When to warm the next track's stream URL (Y4): only once the current one has played
 * [MIN_PLAYED_MS], or within its last [END_WINDOW_MS], so fast skipping costs no requests.
 * Early enough that a weak network has time to get it before the track ends; only the next
 * track, never further ahead.
 */
internal object PrefetchPolicy {
    const val MIN_PLAYED_MS = 10_000L
    const val END_WINDOW_MS = 60_000L

    /**
     * Milliseconds of playback until the next track may be prefetched; 0 = now.
     * [durationMs] <= 0 means unknown (only the played-time rule applies).
     */
    fun delayMs(positionMs: Long, durationMs: Long): Long {
        val byPlay = (MIN_PLAYED_MS - positionMs).coerceAtLeast(0L)
        if (durationMs <= 0) return byPlay
        val byEnd = (durationMs - END_WINDOW_MS - positionMs).coerceAtLeast(0L)
        return minOf(byPlay, byEnd)
    }
}
