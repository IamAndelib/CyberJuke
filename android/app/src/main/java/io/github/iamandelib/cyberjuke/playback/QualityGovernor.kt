package io.github.iamandelib.cyberjuke.playback

/**
 * Auto quality: the [QualityLadder] rung the next tracks play at. It moves one rung at a time,
 * and only between tracks (a playing track keeps its format: the pinned itag):
 * - down: two rebuffers within [REBUFFER_WINDOW_MS], or a bandwidth estimate below
 *   [DOWN_FACTOR] x the current rung's bitrate;
 * - up: [CALM_MS] without a rebuffer (or a step), and an estimate above [UP_FACTOR] x the next
 *   rung up. Recovery from the bottom to the top therefore takes several tracks, never one jump;
 * - never back the other way within [HOLD_TRACKS] tracks of a step (hysteresis).
 *
 * Pure and O(1): the clock and the estimate are passed in (QualityGovernorTest). Main thread.
 */
internal class QualityGovernor {
    /** The rung for tracks resolved from now on: 0 is the top. */
    var rung = 0
        private set

    /** +1 after a step down, -1 after a step up, 0 before the first step. */
    private var lastStep = 0

    /** Tracks started since the last step. */
    private var tracksSinceStep = HOLD_TRACKS

    /** Since when nothing rebuffered or stepped (the first track's start before that). */
    private var calmSince = UNSET

    /** The last two rebuffers since the last step, older first. */
    private var rebufferA = UNSET
    private var rebufferB = UNSET

    /** Playback stalled at [now] to fill the buffer again (not after a seek or a skip). */
    fun onRebuffer(now: Long) {
        rebufferA = rebufferB
        rebufferB = now
        calmSince = now
    }

    /**
     * A track started at [now]. [ladderBps] is its ladder's bitrates, best first (empty when
     * unknown), [estimateBps] the bandwidth estimate in bits per second (<= 0: unknown).
     * Returns [rung], one step from before at most.
     */
    fun onTrackStarted(now: Long, estimateBps: Long, ladderBps: List<Int>): Int {
        if (tracksSinceStep < HOLD_TRACKS) tracksSinceStep++
        if (calmSince == UNSET) calmSince = now
        if (ladderBps.size < 2) return rung
        val cur = rung.coerceIn(0, ladderBps.lastIndex)
        rung = cur
        val rebuffering = rebufferA != UNSET && now - rebufferA <= REBUFFER_WINDOW_MS
        val slow = estimateBps > 0 && estimateBps < DOWN_FACTOR * ladderBps[cur]
        val held = tracksSinceStep < HOLD_TRACKS
        when {
            (rebuffering || slow) && cur < ladderBps.lastIndex && !(held && lastStep < 0) -> step(now, +1)
            cur > 0 && now - calmSince >= CALM_MS && estimateBps > UP_FACTOR * ladderBps[cur - 1] &&
                !(held && lastStep > 0) -> step(now, -1)
        }
        return rung
    }

    private fun step(now: Long, by: Int) {
        rung += by
        lastStep = by
        tracksSinceStep = 0
        calmSince = now
        rebufferA = UNSET
        rebufferB = UNSET
    }

    companion object {
        private const val UNSET = Long.MIN_VALUE

        /** Two rebuffers within this long step down. */
        const val REBUFFER_WINDOW_MS = 3L * 60_000L

        /** This long without a rebuffer (or a step) before a step up. */
        const val CALM_MS = 5L * 60_000L

        /** An estimate below this many times the current rung's bitrate steps down. */
        const val DOWN_FACTOR = 1.5

        /** An estimate above this many times the next rung's bitrate steps up. */
        const val UP_FACTOR = 2.5

        /** No step back the other way within this many tracks of a step. */
        const val HOLD_TRACKS = 2
    }
}
