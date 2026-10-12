package io.github.iamandelib.cyberjuke.playback

/**
 * Auto quality: the [QualityLadder] rung the next tracks play at. It moves one rung at a time,
 * and only between tracks (a playing track keeps its format: the pinned itag), on stalls alone:
 * - down: two rebuffers within [REBUFFER_WINDOW_MS];
 * - up: [CALM_MS] without a rebuffer (or a step). Recovery from the bottom to the top therefore
 *   takes several tracks, never one jump, and a link that can't keep up stalls again and steps
 *   back down;
 * - never back the other way within [HOLD_TRACKS] tracks of a step (hysteresis).
 *
 * No bandwidth estimate: ExoPlayer's also counts the time a load sat idle (a full buffer, a
 * pause), so it says little about what the link can carry.
 *
 * The rung is kept as stepped, not clamped to one video's ladder: a video with fewer rungs
 * plays its own bottom one ([QualityLadder.index]) and leaves the rung for the next video as it
 * was. Pure and O(1): the clock is passed in (QualityGovernorTest). Main thread.
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

    /** Playback stalled at [now] to fill the buffer again (not after a seek, a skip or an edit). */
    fun onRebuffer(now: Long) {
        rebufferA = rebufferB
        rebufferB = now
        calmSince = now
    }

    /**
     * A track started at [now]. [ladderBps] is its ladder's bitrates, best first (empty when
     * unknown). Returns [rung], one step from before at most.
     */
    fun onTrackStarted(now: Long, ladderBps: List<Int>): Int {
        if (tracksSinceStep < HOLD_TRACKS) tracksSinceStep++
        if (calmSince == UNSET) calmSince = now
        if (ladderBps.size < 2) return rung
        // Where this video plays: its own bottom rung when the ladder is shorter.
        val cur = QualityLadder.index(ladderBps.size, rung)
        val rebuffering = rebufferA != UNSET && now - rebufferA <= REBUFFER_WINDOW_MS
        val held = tracksSinceStep < HOLD_TRACKS
        when {
            rebuffering && cur < ladderBps.lastIndex && !(held && lastStep < 0) -> step(now, rung + 1, +1)
            cur > 0 && now - calmSince >= CALM_MS && !(held && lastStep > 0) -> step(now, rung - 1, -1)
        }
        return rung
    }

    private fun step(now: Long, to: Int, by: Int) {
        rung = to
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

        /** No step back the other way within this many tracks of a step. */
        const val HOLD_TRACKS = 2
    }
}

/**
 * Tells a rebuffer (the buffer ran dry while playing) from the buffering a seek, a skip or an
 * edit of the list causes: a jump within [GRACE_MS] makes the next buffering not count.
 * Pure (QualityGovernorTest).
 */
internal class RebufferDetector {
    private var wasReady = false
    private var jumpAt = Long.MIN_VALUE / 2

    /** A seek, a skip, a list change or any other jump the user (or the app) made at [now]. */
    fun onJump(now: Long) {
        jumpAt = now
    }

    /** The playback state changed at [now]. Returns true if this is a rebuffer. */
    fun onState(ready: Boolean, buffering: Boolean, playWhenReady: Boolean, now: Long): Boolean {
        val rebuffer = wasReady && buffering && playWhenReady && now - jumpAt > GRACE_MS
        wasReady = ready
        return rebuffer
    }

    companion object {
        /** Buffering this soon after a jump is the jump's. */
        const val GRACE_MS = 2_000L
    }
}
