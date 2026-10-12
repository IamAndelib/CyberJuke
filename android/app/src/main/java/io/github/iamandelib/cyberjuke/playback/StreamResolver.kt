package io.github.iamandelib.cyberjuke.playback

import android.util.Log
import androidx.media3.common.MimeTypes
import io.github.iamandelib.cyberjuke.findCause
import io.github.iamandelib.cyberjuke.net.FailureKind
import io.github.iamandelib.cyberjuke.net.Family
import io.github.iamandelib.cyberjuke.net.Hosts
import io.github.iamandelib.cyberjuke.net.NetBlock
import io.github.iamandelib.cyberjuke.net.NetEpoch
import io.github.iamandelib.cyberjuke.net.Surface
import io.github.iamandelib.cyberjuke.yt.YtCompat
import io.github.iamandelib.cyberjuke.yt.YtGuard
import java.io.IOException
import java.io.InterruptedIOException
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
    /** [NetEpoch.generation] when the extraction started: older ones are bound to an old IP. */
    val netGen: Int = 0,
    /** The video's quality ladder ([QualityLadder]) as bitrates, best first; empty for a fallback stream. */
    val ladderBps: List<Int> = emptyList(),
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
 * - While [NetBlock] holds a back-off, nothing is resolved, not even from the cache
 *   ([BlockedException]). A bot check or rate limit switches to IPv4 or retries once, then
 *   trips it ([YtGuard]); a successful extraction ends the unproven state.
 * - Re-resolving mid-track keeps the same itag ([reResolve], or a load that starts past byte 0),
 *   so the resumed bytes belong to the same file. Streams are also cached by itag for that.
 * - Quality: the audio-only formats make a ladder ([QualityLadder]); HIGH and LOW are its top
 *   and bottom, AUTO the rung [autoRung] (set between tracks by PlaybackService's
 *   [QualityGovernor]). Every rung of an extraction is cached, so a step costs no request.
 * - A change of network ([NetEpoch]) drops the cached URLs bound to the address family that
 *   changed ([dropBoundTo]); a URL extracted during the change is not cached.
 * - Only https URLs are served ([Hosts.isAllowedMediaUrl]).
 */
internal object StreamResolver {
    private const val TAG = "CyberJukeResolver"
    private const val MAX_CACHE = 100

    /** NewPipe requests googlevideo with POST and body "x\0". Flip if YouTube changes this. */
    const val USE_POST_BODY = true
    val POST_BODY = byteArrayOf(0x78, 0)

    @Volatile
    var quality: AudioQuality = AudioQuality.AUTO

    /** AUTO's rung for tracks resolved from now on (0 = the top); PlaybackService sets it. */
    @Volatile
    var autoRung: Int = 0

    private val cache = TtlLru<String, ResolvedStream>(MAX_CACHE)

    /**
     * The stream last handed out per video (for the itag, the URL's age and expiry), kept
     * [SERVED_TTL_MS] so a resume after a long pause still knows its itag.
     */
    private val served = TtlLru<String, ResolvedStream>(MAX_CACHE)
    private const val SERVED_TTL_MS = 24L * 60L * 60L * 1000L

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

    /** The cache key of a video's [rung] ([QualityLadder.LOWEST]: its bottom one). */
    private fun rungKey(ytId: String, rung: Int) = if (rung == QualityLadder.LOWEST) "$ytId|low" else "$ytId|r$rung"

    private fun currentRung(): Int = QualityLadder.rungFor(quality, autoRung)

    /** [rung] of [ytId] from the cache; a rung past the video's ladder is its bottom one. */
    private fun cached(ytId: String, rung: Int, now: Long): ResolvedStream? =
        cache.get(rungKey(ytId, rung), now)
            ?: cache.get(rungKey(ytId, QualityLadder.LOWEST), now)?.takeIf { rung >= it.ladderBps.size }

    private fun itagKey(ytId: String, itag: Int) = "$ytId|i$itag"

    private fun now() = System.currentTimeMillis()

    /**
     * Blocking. Throws [ResolveException], [ManifestOnlyException] or [BlockedException].
     * [midStream]: the load starts past byte 0 (a resume), so keep the itag in use.
     */
    @Throws(IOException::class)
    fun resolve(ytId: String, midStream: Boolean = false): ResolvedStream {
        // Y1: no request during a back-off, and no stale URL either (a 403 on it would be one).
        NetBlock.check()
        val rung = currentRung()
        val k = rungKey(ytId, rung)
        // A resume keeps the file it was playing: a cached stream of another itag won't do.
        val keep = if (midStream) served.get(ytId, now())?.itag?.takeIf { it > 0 } else null
        val hit = cached(ytId, rung, now())?.takeIf { keep == null || it.itag == keep }
            ?: keep?.let { cache.get(itagKey(ytId, it), now()) }
        if (hit != null) return serve(hit)
        val prefer = pins.remove(ytId) ?: keep
        val flight = if (prefer != null) itagKey(ytId, prefer) else k
        for (attempt in 0..1) {
            val task = FutureTask(Callable { extract(ytId, rung, prefer) })
            val running = inFlight.putIfAbsent(flight, task)
            val mine = running == null
            val job = running ?: task
            if (mine) {
                try {
                    task.run()
                } finally {
                    inFlight.remove(flight, task)
                }
            }
            try {
                return serve(job.get())
            } catch (e: ExecutionException) {
                // Another load's extraction we waited on was cancelled (its thread interrupted,
                // L14): ours was not, so run one of our own.
                if (!mine && attempt == 0 && e.findCause<InterruptedIOException>() != null &&
                    !Thread.currentThread().isInterrupted
                ) {
                    continue
                }
                throw (e.cause as? IOException) ?: IOException(e.cause)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                throw IOException("interrupted", e)
            }
        }
        throw IOException("unreachable")
    }

    private fun serve(s: ResolvedStream): ResolvedStream {
        served.put(s.ytId, s, s.resolvedAtMs + SERVED_TTL_MS)
        return s
    }

    private fun extract(ytId: String, rung: Int, preferItag: Int?): ResolvedStream {
        if (preferItag == null) cached(ytId, rung, now())?.let { return it }
        val gen = NetEpoch.generation
        val started = now()
        val extracted = try {
            // Switches to IPv4 or retries once before a limit counts as a block (LimitPolicy).
            YtGuard.run(Surface.PLAYBACK) { YtCompat.extract(ytId) }
        } catch (e: Exception) {
            val kind = YtCompat.classify(e)
            val reason = YtCompat.describe(e)
            // Details (with the id) only at info level: R8 strips them from release builds.
            Log.i(TAG, "resolve($ytId) failed: $reason")
            Log.w(TAG, "resolve failed: $kind ${e.javaClass.simpleName}")
            if (kind == FailureKind.BROKEN) PlayerBus.emitExtractorBroken(reason)
            throw ResolveException(ytId, reason, e, kind)
        }
        val stream = choose(ytId, extracted, rung, preferItag, gen)
        if (!Hosts.isAllowedMediaUrl(stream.url)) {
            throw ResolveException(ytId, "NO_STREAM: not an https googlevideo URL", null, FailureKind.CONTENT)
        }
        Log.i(TAG, "resolve($ytId) -> ${stream.description} in ${now() - started}ms")
        if (NetEpoch.generation == gen) {
            // Not cached when the network changed meanwhile: the URL is bound to the old IP.
            put(itagKey(ytId, stream.itag), stream)
            val ladder = ladderOf(extracted)
            if (ladder.isEmpty()) {
                // A fallback stream: the same whatever the rung ([cached]).
                val fallback = if (preferItag == null) {
                    stream
                } else {
                    runCatching { choose(ytId, extracted, rung, null, gen) }.getOrNull()
                }
                fallback?.takeIf { Hosts.isAllowedMediaUrl(it.url) }?.let { put(rungKey(ytId, QualityLadder.LOWEST), it) }
            } else {
                // Every rung: Auto steps between tracks without another extraction.
                val bps = ladder.map { it.bitrate }
                ladder.forEachIndexed { i, c ->
                    val s = if (c.itag == stream.itag && c.url == stream.url) stream else rungStream(ytId, c, i, bps, stream.resolvedAtMs, gen)
                    if (!Hosts.isAllowedMediaUrl(s.url)) return@forEachIndexed
                    put(rungKey(ytId, i), s)
                    if (i == ladder.lastIndex) put(rungKey(ytId, QualityLadder.LOWEST), s)
                }
            }
        }
        return stream
    }

    private fun put(key: String, s: ResolvedStream) = cache.put(key, s, StreamUrls.cacheUntil(s.url, s.resolvedAtMs))

    /** The audio-only formats as a quality ladder, original language track preferred. */
    private fun ladderOf(ex: YtCompat.Extracted): List<YtCompat.Candidate> {
        val originals = ex.audio.filter { it.originalTrack }
        return QualityLadder.rank(originals.ifEmpty { ex.audio }, { it.bitrate }, { it.mimeType })
    }

    private fun rungStream(ytId: String, c: YtCompat.Candidate, i: Int, bps: List<Int>, now: Long, gen: Int) =
        stream(ytId, c, "audio ${c.mimeType} ${c.bitrate / 1000}kbps rung ${i + 1}/${bps.size}", now, gen, bps)

    private fun choose(ytId: String, ex: YtCompat.Extracted, rung: Int, preferItag: Int?, gen: Int): ResolvedStream {
        val now = now()

        val ladder = ladderOf(ex)
        val bps = ladder.map { it.bitrate }

        // 0. Resuming: the same format as before, if it is still offered.
        if (preferItag != null && preferItag > 0) {
            (ex.audio + ex.muxed).firstOrNull { it.itag == preferItag }?.let { pick ->
                return stream(ytId, pick, "same itag $preferItag ${pick.mimeType}", now, gen, bps)
            }
        }

        // 1. Progressive audio-only: the ladder's rung for the setting.
        if (ladder.isNotEmpty()) {
            val i = QualityLadder.index(ladder.size, rung)
            return rungStream(ytId, ladder[i], i, bps, now, gen)
        }

        // 2. Lowest progressive muxed (audio+video) stream; ExoPlayer just plays its audio.
        ex.muxed.minByOrNull { if (it.bitrate > 0) it.bitrate else Int.MAX_VALUE }?.let { pick ->
            return stream(ytId, pick, "muxed ${pick.mimeType} ${pick.bitrate}p", now, gen)
        }

        // 3. Adaptive manifest (handled by the service, see ManifestOnlyException).
        ex.hlsUrl?.let { throw ManifestOnlyException(ytId, it, MimeTypes.APPLICATION_M3U8) }

        throw ResolveException(ytId, "NO_STREAM: no playable stream found for $ytId", null, FailureKind.CONTENT)
    }

    private fun stream(
        ytId: String,
        c: YtCompat.Candidate,
        description: String,
        now: Long,
        gen: Int,
        ladderBps: List<Int> = emptyList(),
    ) = ResolvedStream(
        ytId = ytId,
        url = c.url,
        headers = YtCompat.streamHeaders(c.url),
        description = "$description itag=${c.itag}",
        resolvedAtMs = now,
        itag = if (c.itag > 0) c.itag else StreamUrls.itag(c.url) ?: -1,
        netGen = gen,
        ladderBps = ladderBps,
    )

    /** The stream last served for [ytId] (any quality, kept a day, even once expired), or null. */
    fun lastServed(ytId: String): ResolvedStream? = served.get(ytId, now())

    /**
     * Drops the cached URL (expired or rejected) and pins the itag in use, so the next
     * resolution resumes the same file.
     */
    fun reResolve(ytId: String) {
        lastServed(ytId)?.itag?.takeIf { it > 0 }?.let { pins[ytId] = it }
        cache.removeIf { it.startsWith("$ytId|") }
    }

    /** Drops every cached URL (e.g. the IPv4 setting changed: URLs are bound to the IP). */
    fun clear() {
        cache.clear()
        pins.clear()
    }

    /**
     * The network's [families] addresses changed: drops the cached URLs bound to one of them
     * (googlevideo binds a URL to the address that resolved it). A URL bound to the other
     * family, or to none, still works and is kept.
     */
    fun dropBoundTo(families: Set<Family>) {
        if (families.isEmpty()) return
        cache.removeValuesIf { s -> StreamUrls.familyOf(s.url)?.let { it in families } == true }
    }

    /**
     * Best effort: warm the cache for an upcoming item on a background thread. Only the latest
     * request is kept (a newer one cancels it); nothing happens while YouTube backs us off.
     */
    fun prefetch(ytId: String) {
        if (NetBlock.isQuiet()) return
        if (cached(ytId, currentRung(), now()) != null) return
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
