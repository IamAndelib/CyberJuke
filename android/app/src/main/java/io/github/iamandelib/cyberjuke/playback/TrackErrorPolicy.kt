package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.net.BlockReason
import io.github.iamandelib.cyberjuke.net.FailureKind

/**
 * The decision part of PlaybackService's error handling, as a pure function (TrackErrorPolicyTest).
 * Only real per-video failures skip ahead; a block, a network failure or a broken extractor
 * pauses on the item, because every other track would fail the same way. A stream refusal
 * (429, or 403 on a fresh URL) gets one fresh link first, over IPv4 when it came over IPv6 and
 * the setting is Auto; only a second refusal is a block.
 */
internal object TrackErrorPolicy {
    /** A 403 within this long of resolving the URL is stream-token enforcement, not expiry. */
    const val FRESH_URL_MS = 2L * 60L * 1000L

    const val MAX_CONSECUTIVE_FAILURES = 5

    /** Outage pauses on one item in a row (nothing played between) that still resume by themselves. */
    const val MAX_OUTAGE_RESUMES = 3

    data class Facts(
        /** From the resolver ([ResolveException.kind]) or null for a stream (HTTP) failure. */
        val kind: FailureKind?,
        /** HTTP status of a failed stream request, if any. */
        val httpCode: Int? = null,
        /** How long ago the failing stream URL was resolved, if known. */
        val urlAgeMs: Long? = null,
        /** The failing URL is past googlevideo's own `expire` ([StreamUrls.isExpired], Y5). */
        val urlExpired: Boolean = false,
        /** The failing URL was resolved on an earlier network ([io.github.iamandelib.cyberjuke.net.NetEpoch], H1). */
        val resolvedBeforeNetworkChange: Boolean = false,
        /** The item was already re-resolved once after a 403/410. */
        val alreadyReResolved: Boolean = false,
        /** The failing stream URL is bound to an IPv6 address ([StreamUrls.boundToIpv6]). */
        val viaIpv6: Boolean = false,
        /** The IPv4 setting is Auto and not on IPv4 yet ([io.github.iamandelib.cyberjuke.net.NetPrefs.canSwitchToIpv4]). */
        val canSwitchToIpv4: Boolean = false,
        /** Extraction was skipped because a back-off is running ([BlockedException]). */
        val blocked: Boolean = false,
        /** Generic I/O failure while streaming (connection failed, timeout). */
        val ioNetwork: Boolean = false,
        val isCurrent: Boolean = true,
        val hasNext: Boolean = true,
        /** Per-video failures in a row before this one. */
        val consecutiveFailures: Int = 0,
        /** Outage pauses ([Action.Pause] with resume) in a row before this one, nothing played between. */
        val outagePauses: Int = 0,
    )

    sealed class Action {
        /** A back-off is already running: pause where we are, announce nothing new. */
        object WaitBlocked : Action()

        /** Start or extend the network-wide back-off and pause where we are. */
        data class Block(val reason: BlockReason) : Action()

        /** Expired stream URL: resolve again (same itag) and resume at the same position. */
        object ReResolve : Action()

        /** Refused over IPv6 with the IPv4 setting on Auto: switch to IPv4, then [ReResolve]. */
        object SwitchToIpv4 : Action()

        /**
         * Pause on the item without skipping. [resume]: an outage, so it plays on by itself once
         * the network is back (not for a broken extractor, nor an outage that keeps coming back).
         * [freshLink]: the stream's server failed, so that resume must not reuse its URL.
         */
        data class Pause(val resume: Boolean, val freshLink: Boolean = false) : Action()

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
            FailureKind.NETWORK -> return outage(f)
            FailureKind.BROKEN -> return Action.Pause(resume = false)
            else -> Unit
        }
        f.httpCode?.let { code ->
            // A 403 on a URL from an earlier network or past its own expire is no refusal: the
            // URL is bound to the old IP, or simply too old. A fresh one on this network is.
            val stale = f.urlExpired || f.resolvedBeforeNetworkChange
            val fresh403 = code == 403 && !stale && f.urlAgeMs != null && f.urlAgeMs < FRESH_URL_MS
            // A refusal (429, or that fresh 403) over IPv6: try IPv4 first.
            val refused = code == 429 || fresh403
            when {
                refused && f.viaIpv6 && f.canSwitchToIpv4 && !f.alreadyReResolved -> return Action.SwitchToIpv4
                // One fresh link first: the extraction itself tells whether we're blocked.
                code == 429 && !f.alreadyReResolved -> return Action.ReResolve
                code == 429 -> return Action.Block(BlockReason.RATE_LIMIT)
                // An expired URL, or one bound to the old network's IP, is no sign of a block: a
                // fresh link, even a second time (the network changed again meanwhile).
                (code == 403 || code == 410) && (stale || !f.alreadyReResolved) -> return Action.ReResolve
                fresh403 -> return Action.Block(BlockReason.STREAM_FORBIDDEN)
                code >= 500 -> return outage(f, freshLink = true)
                else -> Unit
            }
        }
        if (f.kind == null && f.httpCode == null && f.ioNetwork) return outage(f)
        return perVideo(f)
    }

    private fun outage(f: Facts, freshLink: Boolean = false) =
        Action.Pause(resume = f.outagePauses + 1 < MAX_OUTAGE_RESUMES, freshLink = freshLink)

    /** Skip, PauseAtEnd or Stop: what a real per-video failure does. */
    fun perVideo(f: Facts): Action = when {
        f.consecutiveFailures + 1 >= MAX_CONSECUTIVE_FAILURES -> Action.Stop
        !f.isCurrent || f.hasNext -> Action.Skip
        else -> Action.PauseAtEnd
    }
}
