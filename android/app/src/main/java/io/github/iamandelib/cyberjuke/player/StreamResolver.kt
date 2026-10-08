package io.github.iamandelib.cyberjuke.player

import android.util.Log
import androidx.media3.common.MimeTypes
import java.io.IOException
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask

/** Resolution failed. [kind] says whether it is this video, the network or a block. */
internal class ResolveException(
    val ytId: String,
    message: String,
    cause: Throwable?,
    val kind: FailureKind,
) : IOException(message, cause) {
    /** True if retrying the same video soon is pointless (only network failures retry). */
    val permanent: Boolean get() = kind != FailureKind.NETWORK
}

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
    val itag: Int,
)

/**
 * Turns a YouTube id into a playable stream URL using NewPipeExtractor (via [YtCompat]).
 * Blocking; called on ExoPlayer's loader thread through ResolvingDataSource, so stream
 * URLs are resolved per play/prepare and never ahead of time for the whole queue.
 *
 * - Cache (memory only): until the URL's own `expire` minus 30 minutes ([StreamUrls]), real
 *   LRU of [MAX_CACHE] entries.
 * - Concurrent resolutions of the same video share one extraction (in-flight map, pruned as
 *   each one finishes).
 * - While [NetBlock] holds a back-off, nothing is extracted ([BlockedException]); a bot check
 *   or rate limit trips it.
 * - Re-resolving mid-track keeps the same itag ([reResolve], or a load that starts past byte 0),
 *   so the resumed bytes belong to the same file.
 */
internal object StreamResolver {
    private const val TAG = "CyberJukeResolver"
    private const val MAX_CACHE = 100

    /** NewPipe requests googlevideo with POST and body "x\0". Flip if YouTube changes this. */
    const val USE_POST_BODY = true
    val POST_BODY = byteArrayOf(0x78, 0)

    enum class Quality { HIGH, LOW }

    @Volatile
    var quality: Quality = Quality.HIGH

    private val cache = TtlLru<String, ResolvedStream>(MAX_CACHE)

    /** The stream last handed out per video (for the itag and the URL's age). */
    private val served = TtlLru<String, ResolvedStream>(MAX_CACHE)

    /** ytId -> itag to prefer on the next extraction (set by [reResolve]). */
    private val pins = ConcurrentHashMap<String, Int>()

    private val inFlight = ConcurrentHashMap<String, FutureTask<ResolvedStream>>()

    private val prefetcher = LatestTaskRunner(
        Executors.newSingleThreadExecutor { r ->
            Thread(r, "CyberJuke-prefetch").apply {
                isDaemon = true
                priority = Thread.MIN_PRIORITY
            }
        },
    )

    private fun key(ytId: String, q: Quality) = "$ytId|${q.name}"

    private fun now() = System.currentTimeMillis()

    /**
     * Blocking. Throws [ResolveException], [ManifestOnlyException] or [BlockedException].
     * [midStream]: the load starts past byte 0 (a resume), so keep the itag in use.
     */
    @Throws(IOException::class)
    fun resolve(ytId: String, midStream: Boolean = false): ResolvedStream {
        val q = quality
        val k = key(ytId, q)
        cache.get(k, now())?.let { return serve(it) }
        NetBlock.check()
        val prefer = pins.remove(ytId) ?: if (midStream) served.get(ytId, now())?.itag else null
        val task = FutureTask(Callable { extract(ytId, q, k, prefer) })
        val running = inFlight.putIfAbsent(k, task)
        val mine = running == null
        val job = running ?: task
        if (mine) {
            try {
                task.run()
            } finally {
                inFlight.remove(k, task)
            }
        }
        return try {
            serve(job.get())
        } catch (e: ExecutionException) {
            throw (e.cause as? IOException) ?: IOException(e.cause)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            throw IOException("interrupted", e)
        }
    }

    private fun serve(s: ResolvedStream): ResolvedStream {
        served.put(s.ytId, s, StreamUrls.cacheUntil(s.url, s.resolvedAtMs) + StreamUrls.EXPIRY_MARGIN_MS)
        return s
    }

    private fun extract(ytId: String, q: Quality, k: String, preferItag: Int?): ResolvedStream {
        cache.get(k, now())?.let { return it }
        val started = now()
        val extracted = try {
            YtCompat.extract(ytId)
        } catch (e: Exception) {
            val kind = YtCompat.classify(e)
            val reason = YtCompat.describe(e)
            // Details (with the id) only at info level: R8 strips them from release builds.
            Log.i(TAG, "resolve($ytId) failed: $reason")
            Log.w(TAG, "resolve failed: $kind ${e.javaClass.simpleName}")
            kind.blockReason?.let { NetBlock.trip(it) }
            if (kind == FailureKind.BROKEN) PlayerBus.emitExtractorBroken(reason)
            throw ResolveException(ytId, reason, e, kind)
        }
        val stream = choose(ytId, extracted, q, preferItag)
        Log.i(TAG, "resolve($ytId) -> ${stream.description} in ${now() - started}ms")
        cache.put(k, stream, StreamUrls.cacheUntil(stream.url, stream.resolvedAtMs))
        return stream
    }

    private fun choose(ytId: String, ex: YtCompat.Extracted, q: Quality, preferItag: Int?): ResolvedStream {
        val now = now()

        // 0. Resuming: the same format as before, if it is still offered.
        if (preferItag != null && preferItag > 0) {
            (ex.audio + ex.muxed).firstOrNull { it.itag == preferItag }?.let { pick ->
                return stream(ytId, pick, "same itag $preferItag ${pick.mimeType}", now)
            }
        }

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
            return stream(ytId, pick, "audio ${pick.mimeType} ${pick.bitrate / 1000}kbps", now)
        }

        // 2. Lowest progressive muxed (audio+video) stream; ExoPlayer just plays its audio.
        ex.muxed.minByOrNull { if (it.bitrate > 0) it.bitrate else Int.MAX_VALUE }?.let { pick ->
            return stream(ytId, pick, "muxed ${pick.mimeType} ${pick.bitrate}p", now)
        }

        // 3. Adaptive manifest (handled by the service, see ManifestOnlyException).
        ex.hlsUrl?.let { throw ManifestOnlyException(ytId, it, MimeTypes.APPLICATION_M3U8) }

        throw ResolveException(ytId, "NO_STREAM: no playable stream found for $ytId", null, FailureKind.CONTENT)
    }

    private fun stream(ytId: String, c: YtCompat.Candidate, description: String, now: Long) = ResolvedStream(
        ytId = ytId,
        url = c.url,
        headers = YtCompat.streamHeaders(c.url),
        description = "$description itag=${c.itag}",
        resolvedAtMs = now,
        itag = if (c.itag > 0) c.itag else StreamUrls.itag(c.url) ?: -1,
    )

    /** The stream last served for [ytId] (any quality), or null. */
    fun lastServed(ytId: String): ResolvedStream? = served.get(ytId, now())

    /**
     * Drops the cached URL (expired or rejected) and pins the itag in use, so the next
     * resolution resumes the same file.
     */
    fun reResolve(ytId: String) {
        lastServed(ytId)?.itag?.takeIf { it > 0 }?.let { pins[ytId] = it }
        cache.removeIf { it.startsWith("$ytId|") }
    }

    /** Drops every cached URL (e.g. the network path changed: URLs are bound to the IP). */
    fun clear() {
        cache.clear()
        pins.clear()
    }

    /**
     * Best effort: warm the cache for an upcoming item on a background thread. Only the latest
     * request is kept (a newer one cancels it); nothing happens while YouTube backs us off.
     */
    fun prefetch(ytId: String) {
        if (NetBlock.isQuiet()) return
        if (cache.get(key(ytId, quality), now()) != null) return
        prefetcher.submit(ytId) {
            try {
                resolve(ytId)
            } catch (e: Exception) {
                Log.i(TAG, "prefetch($ytId) failed: ${e.message}")
            }
        }
    }

    /** Cancels a pending prefetch (the user skipped; it is stale). */
    fun cancelPrefetch() = prefetcher.cancel()
}
