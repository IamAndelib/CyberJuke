package io.github.iamandelib.cyberjuke.playback

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

    private val IP = Regex("""[?&/]ip[=/]([0-9A-Fa-f.:%]{2,64})(?:[&/]|$)""")

    /**
     * True if the URL is bound to an IPv6 address (googlevideo's `ip` parameter, URL-encoded
     * colons included), false for IPv4, null if it doesn't say.
     */
    fun boundToIpv6(url: String): Boolean? {
        val ip = IP.find(url)?.groupValues?.get(1) ?: return null
        return ip.contains(':') || ip.contains("%3A", ignoreCase = true)
    }

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

    @Synchronized
    fun clear() = map.clear()

    @Synchronized
    fun size(): Int = map.size
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

    @Synchronized
    fun pendingKey(): String? = key?.takeIf { future?.isDone == false }
}

/**
 * When to warm the next track's stream URL (Y4): only once the current one has played
 * [MIN_PLAYED_MS], or within its last [END_WINDOW_MS], so fast skipping costs no requests.
 */
internal object PrefetchPolicy {
    const val MIN_PLAYED_MS = 30_000L
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
