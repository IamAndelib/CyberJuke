package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.net.BlockReason
import io.github.iamandelib.cyberjuke.net.FailureKind

/**
 * The decision part of PlaybackService's error handling, as a pure function (TrackErrorPolicyTest).
 * Only real per-video failures skip ahead; a block, a network failure or a broken extractor
 * pauses on the item, because every other track would fail the same way. So does an I/O
 * failure that is not clearly the network (a reset connection, a stream that ends early) when
 * the next track would fail too: no validated network, or this track had been playing. A
 * stream refusal
 * (429, or 403 on a fresh URL) gets one fresh link first, over IPv4 when it came over IPv6 and
 * the setting is Auto; only a second refusal is a block.
 */
internal object TrackErrorPolicy {
    /** A 403 within this long of resolving the URL is stream-token enforcement, not expiry. */
    const val FRESH_URL_MS = 2L * 60L * 1000L

    const val MAX_CONSECUTIVE_FAILURES = 5

    /**
     * Outage pauses on one item in a row (nothing played between) that still resume by
     * themselves. Room for [ResumeSchedule]'s tries within its window (six) and a couple of
     * network-callback resumes; the window ends the streak in any case.
     */
    const val MAX_OUTAGE_RESUMES = 8

    /** An unclear I/O failure this many times at the same spot of a track is the track's. */
    const val MAX_FAILURES_HERE = 2

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
        /**
         * Another I/O failure with no HTTP status: unspecified, a stream that ended early, a
         * reset connection. The network, or this file: [networkValidated] and [playedThisItem] tell.
         */
        val ioOther: Boolean = false,
        /** The device has a validated network now. */
        val networkValidated: Boolean = true,
        /** The last item that played is this one: its stream worked until now. */
        val playedThisItem: Boolean = false,
        /** [ioOther] failures of this item at about this position before this one ([FailureSpot]). */
        val failuresHere: Int = 0,
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
        if (f.kind == null && f.httpCode == null) {
            if (f.ioNetwork) return outage(f)
            // Not clearly the network: an outage only when the next track would fail too. Then a
            // good track is not skipped, and a flapping link doesn't stop playback.
            // But the same failure at the same spot again is the file (broken at that point):
            // skip it rather than loop on it.
            if (f.ioOther && (!f.networkValidated || f.playedThisItem) && f.failuresHere + 1 < MAX_FAILURES_HERE) {
                return outage(f)
            }
        }
        return perVideo(f)
    }

    /**
     * Whether [f] is decided by the unclear I/O failure, so it counts at its spot
     * ([FailureSpot], [Facts.failuresHere]): not a resolver, HTTP or plain connection failure.
     */
    fun countsAtSpot(f: Facts): Boolean = f.ioOther && f.kind == null && f.httpCode == null && !f.ioNetwork && !f.blocked

    /**
     * After [action], the failed item keeps its format when it loads again from its start: it
     * is paused on, it is the current one and it was playing ([played], or a position past 0).
     */
    fun keepsFormat(action: Action, isCurrent: Boolean, played: Boolean, positionMs: Long): Boolean {
        val pausedOn = action is Action.Pause || action is Action.Block || action == Action.WaitBlocked
        return pausedOn && isCurrent && (played || positionMs > 0L)
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

/**
 * Counts unclear I/O failures of one item at about one position ([TrackErrorPolicy.Facts.failuresHere]).
 * Reaching READY again doesn't reset it (a resume plays the buffer up to the same bad spot); a
 * new item, or a failure more than [NEAR_MS] away from the last one, starts over. Pure
 * (TrackErrorPolicyTest). Main thread.
 */
internal class FailureSpot {
    private var id: String? = null
    private var positionMs = 0L
    private var count = 0

    /** An unclear I/O failure of [id] at [positionMs]. Returns how many came before it at this spot. */
    fun onFailure(id: String, positionMs: Long): Int {
        if (id != this.id || kotlin.math.abs(positionMs - this.positionMs) > NEAR_MS) {
            this.id = id
            count = 0
        }
        this.positionMs = positionMs
        return count++
    }

    /** Another item plays. */
    fun clear() {
        id = null
        count = 0
    }

    companion object {
        /** Failures this close to each other are at the same spot. */
        const val NEAR_MS = 30_000L
    }
}
