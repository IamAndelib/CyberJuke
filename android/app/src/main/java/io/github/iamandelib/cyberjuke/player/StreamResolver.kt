package io.github.iamandelib.cyberjuke.player

import android.util.Log
import androidx.media3.common.MimeTypes
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Resolution failed. [permanent] means retrying the same video is pointless. */
internal class ResolveException(
    val ytId: String,
    message: String,
    cause: Throwable?,
    val permanent: Boolean,
) : IOException(message, cause)

/**
 * No progressive stream exists, only an adaptive manifest. The service catches this in
 * onPlayerError and swaps the item for the manifest URL with the right MIME type, because
 * the media source type has to be known before the item is prepared.
 */
internal class ManifestOnlyException(
    val ytId: String,
    val manifestUrl: String,
    val mimeType: String,
) : IOException("No progressive stream for $ytId, only a manifest ($mimeType)")

internal data class ResolvedStream(
    val ytId: String,
    val url: String,
    val headers: Map<String, String>,
    val description: String,
    val resolvedAtMs: Long,
)

/**
 * Turns a YouTube id into a playable stream URL using NewPipeExtractor (via [YtCompat]).
 * Blocking; called on ExoPlayer's loader thread through ResolvingDataSource, so stream
 * URLs are resolved per play/prepare and never ahead of time for the whole queue.
 */
internal object StreamResolver {
    private const val TAG = "CyberJukeResolver"

    /** googlevideo URLs normally live ~6h; stay well below that. */
    private const val TTL_MS = 60L * 60L * 1000L
    private const val MAX_CACHE = 200

    /** NewPipe requests googlevideo with POST and body "x\0". Flip if YouTube changes this. */
    const val USE_POST_BODY = true
    val POST_BODY = byteArrayOf(0x78, 0)

    enum class Quality { HIGH, LOW }

    @Volatile
    var quality: Quality = Quality.HIGH

    private val cache = ConcurrentHashMap<String, ResolvedStream>()
    private val locks = ConcurrentHashMap<String, Any>()
    private val prefetchExecutor: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "CyberJuke-prefetch").apply {
            isDaemon = true
            priority = Thread.MIN_PRIORITY
        }
    }

    private fun key(ytId: String, q: Quality) = "$ytId|${q.name}"

    private fun fresh(s: ResolvedStream?): ResolvedStream? =
        s?.takeIf { System.currentTimeMillis() - it.resolvedAtMs < TTL_MS }

    /** Blocking. Throws [ResolveException] or [ManifestOnlyException]. */
    @Throws(IOException::class)
    fun resolve(ytId: String): ResolvedStream {
        val q = quality
        val k = key(ytId, q)
        fresh(cache[k])?.let { return it }
        val lock = locks.getOrPut(k) { Any() }
        synchronized(lock) {
            fresh(cache[k])?.let { return it }
            val started = System.currentTimeMillis()
            val extracted = try {
                YtCompat.extract(ytId)
            } catch (e: Exception) {
                val reason = YtCompat.describe(e)
                Log.e(TAG, "resolve($ytId) failed: $reason", e)
                throw ResolveException(ytId, reason, e, YtCompat.isPermanent(e))
            }
            val stream = choose(ytId, extracted, q)
            Log.i(
                TAG,
                "resolve($ytId) -> ${stream.description} in ${System.currentTimeMillis() - started}ms",
            )
            if (cache.size > MAX_CACHE) prune()
            cache[k] = stream
            return stream
        }
    }

    private fun choose(ytId: String, ex: YtCompat.Extracted, q: Quality): ResolvedStream {
        val now = System.currentTimeMillis()

        // 1. Progressive audio-only, original language track preferred.
        val originals = ex.audio.filter { it.originalTrack }
        val audio = originals.ifEmpty { ex.audio }
        if (audio.isNotEmpty()) {
            // Unknown bitrate (-1) sorts as "worst" for HIGH and is avoided for LOW.
            val sorted = audio.sortedWith(
                compareByDescending<YtCompat.Candidate> { it.bitrate }
                    .thenByDescending { YtCompat.isPreferredContainer(it.mimeType) }
                    .thenByDescending { it.mimeType == MimeTypes.AUDIO_MP4 },
            )
            val pick = when (q) {
                Quality.HIGH -> sorted.first()
                Quality.LOW -> sorted.lastOrNull { it.bitrate > 0 } ?: sorted.last()
            }
            return ResolvedStream(
                ytId, pick.url, YtCompat.streamHeaders(pick.url),
                "audio ${pick.mimeType} ${pick.bitrate / 1000}kbps", now,
            )
        }

        // 2. Lowest progressive muxed (audio+video) stream; ExoPlayer just plays its audio.
        ex.muxed.minByOrNull { if (it.bitrate > 0) it.bitrate else Int.MAX_VALUE }?.let { pick ->
            return ResolvedStream(
                ytId, pick.url, YtCompat.streamHeaders(pick.url),
                "muxed ${pick.mimeType} ${pick.bitrate}p", now,
            )
        }

        // 3. Adaptive manifest (handled by the service, see ManifestOnlyException).
        ex.hlsUrl?.let { throw ManifestOnlyException(ytId, it, MimeTypes.APPLICATION_M3U8) }

        throw ResolveException(ytId, "NO_STREAM: no playable stream found for $ytId", null, true)
    }

    fun invalidate(ytId: String) {
        cache.keys.removeAll { it.startsWith("$ytId|") }
    }

    fun clear() = cache.clear()

    /** Best effort: warm the cache for an upcoming item on a background thread. */
    fun prefetch(ytId: String) {
        if (fresh(cache[key(ytId, quality)]) != null) return
        prefetchExecutor.execute {
            try {
                resolve(ytId)
            } catch (e: Exception) {
                Log.w(TAG, "prefetch($ytId) failed: ${e.message}")
            }
        }
    }

    private fun prune() {
        val now = System.currentTimeMillis()
        cache.entries.removeAll { now - it.value.resolvedAtMs >= TTL_MS }
        if (cache.size > MAX_CACHE) cache.clear()
    }
}
