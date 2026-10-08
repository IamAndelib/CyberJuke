package io.github.iamandelib.cyberjuke.player

import io.github.iamandelib.cyberjuke.net.BlockReason
import io.github.iamandelib.cyberjuke.net.FailureKind

/**
 * The decision part of PlaybackService's error handling, as a pure function (TrackErrorPolicyTest).
 * Only real per-video failures skip ahead; a block, a network failure or a broken extractor
 * pauses on the item, because every other track would fail the same way.
 */
internal object TrackErrorPolicy {
    /** A 403 within this long of resolving the URL is stream-token enforcement, not expiry. */
    const val FRESH_URL_MS = 2L * 60L * 1000L

    const val MAX_CONSECUTIVE_FAILURES = 5

    data class Facts(
        /** From the resolver ([ResolveException.kind]) or null for a stream (HTTP) failure. */
        val kind: FailureKind?,
        /** HTTP status of a failed stream request, if any. */
        val httpCode: Int? = null,
        /** How long ago the failing stream URL was resolved, if known. */
        val urlAgeMs: Long? = null,
        /** The item was already re-resolved once after a 403/410. */
        val alreadyReResolved: Boolean = false,
        /** Extraction was skipped because a back-off is running ([BlockedException]). */
        val blocked: Boolean = false,
        /** Generic I/O failure while streaming (connection failed, timeout). */
        val ioNetwork: Boolean = false,
        val isCurrent: Boolean = true,
        val hasNext: Boolean = true,
        /** Per-video failures in a row before this one. */
        val consecutiveFailures: Int = 0,
    )

    sealed class Action {
        /** A back-off is already running: pause where we are, announce nothing new. */
        object WaitBlocked : Action()

        /** Start or extend the network-wide back-off and pause where we are. */
        data class Block(val reason: BlockReason) : Action()

        /** Expired stream URL: resolve again (same itag) and resume at the same position. */
        object ReResolve : Action()

        /** Pause on the item without skipping (offline, or [broken] extractor). */
        data class Pause(val broken: Boolean) : Action()

        /** Per-video failure: skip the current item (or drop an upcoming one). */
        object Skip : Action()

        /** Per-video failure on the last item: stay on it, paused. */
        object PauseAtEnd : Action()

        /** Too many per-video failures in a row: stop. */
        object Stop : Action()
    }

    fun decide(f: Facts): Action {
        if (f.blocked) return Action.WaitBlocked
        f.kind?.blockReason?.let { return Action.Block(it) }
        when (f.kind) {
            FailureKind.NETWORK -> return Action.Pause(broken = false)
            FailureKind.BROKEN -> return Action.Pause(broken = true)
            else -> Unit
        }
        f.httpCode?.let { code ->
            when {
                code == 429 -> return Action.Block(BlockReason.RATE_LIMIT)
                code == 403 && f.urlAgeMs != null && f.urlAgeMs < FRESH_URL_MS ->
                    return Action.Block(BlockReason.STREAM_FORBIDDEN)
                (code == 403 || code == 410) && !f.alreadyReResolved -> return Action.ReResolve
                code >= 500 -> return Action.Pause(broken = false)
                else -> Unit
            }
        }
        if (f.kind == null && f.httpCode == null && f.ioNetwork) return Action.Pause(broken = false)
        return perVideo(f)
    }

    private fun perVideo(f: Facts): Action = when {
        f.consecutiveFailures + 1 >= MAX_CONSECUTIVE_FAILURES -> Action.Stop
        !f.isCurrent || f.hasNext -> Action.Skip
        else -> Action.PauseAtEnd
    }
}
