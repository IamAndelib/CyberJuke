package io.github.iamandelib.cyberjuke.playback

import android.os.Handler
import android.os.SystemClock
import android.util.Log
import androidx.media3.common.MediaItem
import io.github.iamandelib.cyberjuke.net.FailureKind
import io.github.iamandelib.cyberjuke.net.NetBlock
import io.github.iamandelib.cyberjuke.net.Surface
import io.github.iamandelib.cyberjuke.yt.Radio
import io.github.iamandelib.cyberjuke.yt.YtCompat
import io.github.iamandelib.cyberjuke.yt.YtGuard
import io.github.iamandelib.cyberjuke.yt.YtMusic
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Autoplay for a Global seed: its YouTube Music radio, refilled in the service so it keeps
 * going with the screen off (AP3, AP4). One page at a time, on its own thread; never during a
 * back-off of the music features (Y1). A failed or all-duplicate page is retried a bounded
 * number of times (L5); at the end of a radio, a new one starts from its last song.
 *
 * Main thread only, apart from the page fetch itself.
 */
internal class RadioFeeder(private val handler: Handler, private val host: Host) {
    interface Host {
        /** The YouTube ids already in the player, so a page adds nothing twice. */
        fun ytIdsInPlayer(): Set<String>

        /** Adds a page's items as autoplay, if autoplay still applies; false if it doesn't. */
        fun addRadioItems(items: List<MediaItem>): Boolean

        /**
         * Forgets the last "low" state so the next check acts again, and checks again after
         * [delayMs] (null: no scheduled check).
         */
        fun recheckLow(delayMs: Long?)
    }

    private data class State(val ytId: String, val next: String?)

    private var state: State? = null

    /** Bumped when the seed changes or autoplay stops: a page fetched for the old one is dropped. */
    private var gen = 0
    private var inFlight = false

    /** Retries since the radio last added items (an empty or failed page); bounded. */
    private var retries = 0

    /** No request before this (SystemClock.elapsedRealtime), after a failed page. */
    private var notBefore = 0L

    private val executor: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "JukeRadio").apply { isDaemon = true }
    }

    /** Whether autoplay is a radio (a Global seed) rather than the web side's Jukebox picks. */
    val active: Boolean get() = state != null

    /** Autoplay follows [seed] now: a radio for a Global track, nothing otherwise. */
    fun reseed(seed: MediaItem?) {
        stop()
        retries = 0
        notBefore = 0L
        val ytId = seed?.takeIf { it.mediaId.startsWith(QueueCommands.GLOBAL_PREFIX) }?.let { JukeUris.ytIdOf(it) }
        state = ytId?.let { State(it, null) }
    }

    /** Autoplay turned off: drop a page on its way. */
    fun stop() {
        gen++
        inFlight = false
    }

    fun shutdown() {
        stop()
        executor.shutdownNow()
    }

    /** Fetches the next page, unless one is on its way or a wait is running. */
    fun refill() {
        val r = state ?: return
        if (inFlight) return
        val wait = maxOf(
            NetBlock.active(Surface.MUSIC).first - System.currentTimeMillis(),
            notBefore - SystemClock.elapsedRealtime(),
        )
        if (wait > 0) {
            // Try again once the back-off (or the retry delay) is over, even with no event.
            host.recheckLow(if (retries < MAX_RETRIES) wait + 1000L else null)
            return
        }
        inFlight = true
        val myGen = gen
        try {
            executor.execute {
                // A limit here holds the music features only, never playback (YtGuard).
                val result = runCatching { YtGuard.run(Surface.MUSIC) { YtMusic.radio(r.ytId, r.next) } }
                handler.post { onPage(myGen, r, result) }
            }
        } catch (_: Exception) { // RejectedExecutionException after shutdown
            inFlight = false
        }
    }

    private fun onPage(myGen: Int, r: State, result: Result<Radio.Page>) {
        if (myGen != gen) return
        inFlight = false
        result.onFailure { t ->
            val kind = YtCompat.classify(t)
            Log.w(TAG, "Radio failed [$kind]: ${t.javaClass.simpleName}")
            if (kind == FailureKind.BROKEN) PlayerBus.emitExtractorBroken(YtCompat.describe(t))
            // A failed page must not stall the radio: retry later (bounded).
            retry(delayMs = RETRY_MS * (retries + 1))
        }
        val page = result.getOrNull() ?: return
        val have = HashSet(host.ytIdsInPlayer())
        val items = page.items.mapNotNull { it ->
            val ytId = it.ytId ?: return@mapNotNull null
            if (!have.add(ytId)) return@mapNotNull null
            runCatching {
                JukeTracks.toMediaItem(
                    JSONObject()
                        .put("id", QueueCommands.GLOBAL_PREFIX + ytId)
                        .put("ytId", ytId)
                        .put("title", it.title)
                        .put("artist", Radio.cleanCredit(it.subtitle))
                        .put("artworkUrl", "https://i.ytimg.com/vi/$ytId/hqdefault.jpg"),
                )
            }.getOrNull()
        }
        // At the end of a radio, start a new one from its last song.
        state = when {
            page.next != null -> r.copy(next = page.next)
            items.isNotEmpty() -> JukeUris.ytIdOf(items.last())?.let { State(it, null) }
            else -> null
        }
        Log.i(TAG, "Radio: ${items.size} new of ${page.items.size}, more=${page.next != null}")
        if (items.isNotEmpty()) {
            if (host.addRadioItems(items)) retries = 0
        } else if (state != null) {
            // Nothing new on this page (all duplicates) but the radio goes on: the next page.
            retry(delayMs = 0L)
        }
    }

    /** Checks the low state again after [delayMs], at most [MAX_RETRIES] times in a row. */
    private fun retry(delayMs: Long) {
        if (retries >= MAX_RETRIES) {
            Log.w(TAG, "Radio: giving up after $retries retries")
            return
        }
        retries++
        notBefore = SystemClock.elapsedRealtime() + delayMs
        host.recheckLow(delayMs)
    }

    private companion object {
        const val TAG = "CyberJukeRadio"
        const val MAX_RETRIES = 3
        const val RETRY_MS = 15_000L
    }
}
