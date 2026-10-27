package io.github.iamandelib.cyberjuke.playback

import java.io.EOFException
import java.io.InterruptedIOException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * How far ahead the player buffers (PlaybackService's DefaultLoadControl). Audio is about 1 MB
 * a minute, so most of a track is buffered early and a short drop is never heard. Pure
 * (LoadPolicyTest checks what DefaultLoadControl.Builder would refuse at service start).
 */
internal object BufferPolicy {
    /** Keep loading until this much is buffered (Media3's default is 50 s). */
    const val MIN_MS = 120_000

    /** Never more than this. */
    const val MAX_MS = 600_000

    /** Start playing once this much is there. */
    const val START_MS = 2_500

    /** After a stall, wait for a little more, so it doesn't stall again at once. */
    const val AFTER_REBUFFER_MS = 5_000

    /** Kept behind the position, so seeking back a little costs nothing. */
    const val BACK_MS = 30_000

    /**
     * The memory cap: 10 minutes at 160 kbps (an audio-only stream never reaches it). Below
     * [MIN_MS] loading goes on regardless (time wins over size); past it this is the limit,
     * which only a video fallback stream would hit.
     */
    const val TARGET_BYTES = 16 * 1024 * 1024
}

/**
 * Retries of a failed load (JukeLoadErrorPolicy). Whatever ExoPlayer's default would retry is
 * retried here too, never given up on early: the minimum retry count ([NETWORK_RETRIES]) decides
 * when an error reaches the player (once it needs the data). A network-class error (the
 * connection failed, was reset or stalled, or the resolver couldn't reach YouTube, as after a
 * change of network) waits with a capped back-off ([delayMs]); any other with ExoPlayer's default,
 * 1 s more each time up to 5 s. Pure (LoadPolicyTest).
 */
internal object LoadRetry {
    const val NETWORK_RETRIES = 6

    const val MAX_DELAY_MS = 8_000L

    /**
     * HTTP statuses that mean "not now" rather than "no": a request timeout and too many
     * requests. On a host whose other 4xx are final (latex.gg) they are retried like a broken
     * connection. YouTube's 429 is a refusal instead (JukeLoadErrorPolicy.NO_RETRY_HTTP).
     */
    val TRANSIENT_HTTP: Set<Int> = setOf(408, 429)

    /** A YouTube load's cache file that went away: retried this soon ([cacheFileRetryMs]). */
    const val CACHE_RETRY_MS = 500L

    /**
     * A YouTube load ([ytLoad]) that failed reading a listening-cache file ([fileError]: not
     * found, or a file read error): the cache drops the span when it notices, so a retry soon
     * fetches it instead (the default would never retry a missing file: a dead track). Null for
     * anything else.
     */
    fun cacheFileRetryMs(ytLoad: Boolean, fileError: Boolean): Long? = if (ytLoad && fileError) CACHE_RETRY_MS else null

    /** 1 s, 2 s, 4 s, then [MAX_DELAY_MS], for the [errorCount]th error in a row (from 1). */
    fun delayMs(errorCount: Int): Long = (1_000L shl (errorCount - 1).coerceIn(0, 4)).coerceAtMost(MAX_DELAY_MS)

    /** The wait before retrying the [errorCount]th error in a row (always retried). */
    fun retryDelayMs(errorCount: Int, network: Boolean): Long =
        if (network) delayMs(errorCount) else minOf((errorCount - 1).coerceAtLeast(0) * 1_000L, 5_000L)

    /**
     * A network-class failure: not an HTTP status, and the transport broke ([httpTransport]: an
     * HTTP data source error without a status; or [transportCause]) or the resolver failed on
     * the network ([resolverNetwork]: ResolveException of kind NETWORK).
     */
    fun isNetwork(httpStatus: Boolean, resolverNetwork: Boolean, httpTransport: Boolean, transportCause: Boolean): Boolean =
        !httpStatus && (resolverNetwork || httpTransport || transportCause)

    /** A reset or refused socket, a timeout, an unknown host or a stream that ended early among [t]'s causes. */
    fun hasTransportCause(t: Throwable): Boolean {
        var c: Throwable? = t
        var depth = 0
        while (c != null && depth < 16) {
            if (c is SocketException || c is SocketTimeoutException || c is UnknownHostException || c is EOFException) {
                return true
            }
            c = c.cause
            depth++
        }
        return false
    }
}

/**
 * How far ahead the player may load: the playing item and the next one in play order, never
 * further. A deep buffer would otherwise load two or three items ahead, each one an extraction
 * and several MB (the resource budget: at most one track fetched ahead). The next one only
 * when [wanted]: Gapless playback (Settings) buffers it while this one plays, so ExoPlayer's
 * own transition is seamless. Off, the next item is still prepared as ExoPlayer wants it (its
 * link resolved, the stream opened and its first chunk read, up to the extractor's
 * continue-loading check), but the load control refuses it any further loading until it is
 * current, so a skip costs little data. A prepared period that isn't loading is a normal state:
 * nothing is loading, so the player is ready to move on, makes the transition by itself at the
 * end of this track, and the next one then buffers at its start (a cold start after playing
 * counts as a rebuffer: BufferPolicy.AFTER_REBUFFER_MS, about five seconds of audio, plus the
 * round trip), which is the short pause the listener hears. With Crossfade on it is [wanted] too:
 * the next track then goes into the listening cache while this one plays, and the fade's new
 * player starts it from there. Pure (LoadPolicyTest).
 */
internal object LoadAhead {
    /** C.INDEX_UNSET. */
    const val UNSET = -1

    /** Whether the next track is readied early: Gapless on, or a crossfade set (its new player then finds the next track cached). */
    fun wanted(gapless: Boolean, crossfadeMs: Int): Boolean = gapless || crossfadeMs > 0

    /** The index to load ahead of the current one: [next] when [wanted], else none ([mayLoad] then allows the current item only). */
    fun nextToLoad(wanted: Boolean, next: Int): Int = if (wanted) next else UNSET

    /**
     * Whether the item at [loadingIndex] may keep loading while [currentIndex] plays and
     * [nextIndex] follows it in play order (UNSET when unknown: nothing is held back then).
     */
    fun mayLoad(loadingIndex: Int, currentIndex: Int, nextIndex: Int): Boolean =
        loadingIndex == UNSET || currentIndex == UNSET || loadingIndex == currentIndex || loadingIndex == nextIndex
}

/**
 * Which tracks may open their stream: the playing one and the next (by ytId, whether or not
 * [LoadAhead] lets the next load ahead yet). OneAheadLoadControl stops loading beyond them, but
 * ExoPlayer still prepares the item after next, and preparing opens its source: an extraction,
 * and a connection left idle. Its resolution waits here instead (YtDataSpecResolver, on the
 * loader thread) until the pair includes it, woken when the pair changes, never polled; the
 * interrupt of a cancelled or released load ends the wait. Nothing set (empty): no gate.
 * Thread-safe. Pure (LoadPolicyTest).
 */
internal class OpenGate {
    private val lock = ReentrantLock()
    private val changed = lock.newCondition()

    @Volatile
    private var allowed: Set<String> = emptySet()

    /** The tracks that may open now (main thread); empty lets everything through. */
    fun allow(ytIds: Set<String>) = lock.withLock {
        allowed = ytIds
        changed.signalAll()
    }

    /** Blocks until [ytId] may open. Throws InterruptedIOException if the load is cancelled meanwhile. */
    @Throws(InterruptedIOException::class)
    fun await(ytId: String) {
        if (mayOpen(ytId, allowed)) return
        lock.withLock {
            while (!mayOpen(ytId, allowed)) {
                try {
                    changed.await()
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw InterruptedIOException("Load cancelled while waiting for its turn")
                }
            }
        }
    }

    companion object {
        fun mayOpen(ytId: String, allowed: Set<String>): Boolean = allowed.isEmpty() || ytId in allowed
    }
}
