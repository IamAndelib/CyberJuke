package io.github.iamandelib.cyberjuke.playback

import java.io.EOFException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

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
 * Retries of a failed load (JukeLoadErrorPolicy). A network error (the connection failed, was
 * reset or stalled: not an HTTP status, not the resolver) is tried again [NETWORK_RETRIES] times,
 * with a capped back-off, before it reaches the player, while the buffer covers the gap. Every
 * other error keeps ExoPlayer's default: [DEFAULT_RETRIES], waiting 1 s more each time up to 5 s.
 * Pure (LoadPolicyTest).
 */
internal object LoadRetry {
    const val NETWORK_RETRIES = 6

    /** ExoPlayer's default minimum retry count. */
    const val DEFAULT_RETRIES = 3

    const val MAX_DELAY_MS = 8_000L

    /** 1 s, 2 s, 4 s, then [MAX_DELAY_MS], for the [errorCount]th error in a row (from 1). */
    fun delayMs(errorCount: Int): Long = (1_000L shl (errorCount - 1).coerceIn(0, 4)).coerceAtMost(MAX_DELAY_MS)

    /**
     * The wait before retrying the [errorCount]th error in a row, or null to give up now (the
     * player gets the error at once). The policy's minimum retry count is [NETWORK_RETRIES] for
     * every load (it can't tell errors apart), so other errors give up here after
     * [DEFAULT_RETRIES], as they did by default.
     */
    fun retryDelayMs(errorCount: Int, network: Boolean): Long? = when {
        network -> delayMs(errorCount)
        errorCount > DEFAULT_RETRIES -> null
        else -> minOf((errorCount - 1).coerceAtLeast(0) * 1_000L, 5_000L)
    }

    /**
     * A network-class failure: the transport broke ([httpTransport]: an HTTP data source error
     * without a status; or [transportCause]), and it is neither an HTTP status nor the resolver's.
     */
    fun isNetwork(httpStatus: Boolean, resolver: Boolean, httpTransport: Boolean, transportCause: Boolean): Boolean =
        !httpStatus && !resolver && (httpTransport || transportCause)

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
 * and several MB (the resource budget: at most one track fetched ahead). Pure (LoadPolicyTest).
 */
internal object LoadAhead {
    /** C.INDEX_UNSET. */
    const val UNSET = -1

    /**
     * Whether the item at [loadingIndex] may keep loading while [currentIndex] plays and
     * [nextIndex] follows it in play order (UNSET when unknown: nothing is held back then).
     */
    fun mayLoad(loadingIndex: Int, currentIndex: Int, nextIndex: Int): Boolean =
        loadingIndex == UNSET || currentIndex == UNSET || loadingIndex == currentIndex || loadingIndex == nextIndex
}
