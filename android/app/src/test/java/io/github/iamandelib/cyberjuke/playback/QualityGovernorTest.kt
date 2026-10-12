package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QualityGovernorTest {
    private val min = 60_000L
    private val sec = 1_000L
    private val ladder = listOf(160_000, 128_000, 64_000, 48_000)

    /** Plenty for every rung (above 2.5 x the top), and too little for any (below 1.5 x the bottom). */
    private val fast = 10_000_000L
    private val slow = 50_000L

    /** Two rebuffers just before [at]: the next track steps down. */
    private fun stall(g: QualityGovernor, at: Long) {
        g.onRebuffer(at - 20 * sec)
        g.onRebuffer(at - 10 * sec)
    }

    @Test
    fun startsAtTheTopAndStaysThereOnAGoodLink() {
        val g = QualityGovernor()
        assertEquals(0, g.rung)
        var now = 0L
        repeat(10) {
            assertEquals(0, g.onTrackStarted(now, fast, ladder))
            now += 4 * min
        }
    }

    @Test
    fun aLowEstimateAloneNeverStepsDown() {
        // The estimate counts loads that sat idle (a full buffer, a pause): only stalls step down.
        val g = QualityGovernor()
        assertEquals(0, g.onTrackStarted(0L, slow, ladder))
        assertEquals(0, g.onTrackStarted(3 * min, 1L, ladder))
        assertEquals(0, g.onTrackStarted(6 * min, slow, ladder))
    }

    @Test
    fun twoRebuffersWithinThreeMinutesStepDownOneRung() {
        val g = QualityGovernor()
        g.onTrackStarted(0L, fast, ladder)
        g.onRebuffer(1 * min)
        // One rebuffer is no pattern.
        assertEquals(0, g.onTrackStarted(2 * min, fast, ladder))
        g.onRebuffer(3 * min)
        assertEquals(1, g.onTrackStarted(4 * min, fast, ladder))
        // Those rebuffers were answered by that step: not counted again.
        assertEquals(1, g.onTrackStarted(5 * min, fast, ladder))
        // Stalling on: one rung per track, never straight to the bottom.
        stall(g, 6 * min)
        assertEquals(2, g.onTrackStarted(6 * min, slow, ladder))
        stall(g, 7 * min)
        assertEquals(3, g.onTrackStarted(7 * min, slow, ladder))
        stall(g, 8 * min)
        assertEquals(3, g.onTrackStarted(8 * min, slow, ladder))
    }

    @Test
    fun rebuffersFurtherApartOrLongAgoDoNot() {
        val g = QualityGovernor()
        g.onTrackStarted(0L, fast, ladder)
        g.onRebuffer(1 * min)
        g.onRebuffer(5 * min) // four minutes apart
        assertEquals(0, g.onTrackStarted(6 * min, fast, ladder))
        val h = QualityGovernor()
        h.onTrackStarted(0L, fast, ladder)
        h.onRebuffer(1 * min)
        h.onRebuffer(2 * min)
        // Both more than three minutes before this track: over.
        assertEquals(0, h.onTrackStarted(6 * min, fast, ladder))
    }

    @Test
    fun upOneRungOnlyAfterFiveCalmMinutesAndAFastEnoughLink() {
        val g = QualityGovernor()
        stall(g, 0L)
        g.onTrackStarted(0L, slow, ladder) // down to 1
        stall(g, 3 * min)
        g.onTrackStarted(3 * min, slow, ladder) // down to 2 at 3 min
        // 2.5 x 128 = 320 kbps needed for rung 1; and five minutes since the last step.
        assertEquals(2, g.onTrackStarted(6 * min, fast, ladder))
        assertEquals(2, g.onTrackStarted(9 * min, 300_000L, ladder))
        assertEquals(1, g.onTrackStarted(9 * min, 330_000L, ladder))
        // The next step up waits five minutes again: recovery takes several tracks.
        assertEquals(1, g.onTrackStarted(12 * min, fast, ladder))
        assertEquals(0, g.onTrackStarted(14 * min, fast, ladder))
    }

    @Test
    fun aRebufferRestartsTheCalmBeforeAStepUp() {
        val g = QualityGovernor()
        stall(g, 0L)
        g.onTrackStarted(0L, slow, ladder) // rung 1
        g.onRebuffer(4 * min)
        assertEquals(1, g.onTrackStarted(6 * min, fast, ladder))
        assertEquals(1, g.onTrackStarted(8 * min, fast, ladder))
        assertEquals(0, g.onTrackStarted(9 * min, fast, ladder))
    }

    @Test
    fun noReversalWithinTwoTracksOfAStep() {
        val g = QualityGovernor()
        stall(g, 0L)
        g.onTrackStarted(0L, slow, ladder) // down to 1
        // A long track: five calm minutes and a fast link, but only one track since the step.
        assertEquals(1, g.onTrackStarted(6 * min, fast, ladder))
        // The second track since: up again...
        assertEquals(0, g.onTrackStarted(10 * min, fast, ladder))
        // ...and stalls right after that step don't reverse it.
        stall(g, 11 * min)
        assertEquals(0, g.onTrackStarted(11 * min, slow, ladder))
        // Two tracks on, stalls step down again.
        stall(g, 12 * min)
        assertEquals(1, g.onTrackStarted(12 * min, slow, ladder))
    }

    @Test
    fun anUnknownEstimateOrLadderChangesNothing() {
        val g = QualityGovernor()
        assertEquals(0, g.onTrackStarted(0L, 0L, ladder))
        assertEquals(0, g.onTrackStarted(10 * min, -1L, ladder))
        // A single rung (or no ladder: a fallback stream) has nowhere to step.
        stall(g, 11 * min)
        assertEquals(0, g.onTrackStarted(11 * min, slow, listOf(128_000)))
        assertEquals(0, g.onTrackStarted(12 * min, slow, emptyList()))
    }

    @Test
    fun aShorterLadderPlaysItsBottomAndLeavesTheRungAsItWas() {
        val g = QualityGovernor()
        stall(g, 0L)
        g.onTrackStarted(0L, slow, ladder)
        stall(g, 3 * min)
        g.onTrackStarted(3 * min, slow, ladder)
        stall(g, 6 * min)
        g.onTrackStarted(6 * min, slow, ladder)
        assertEquals(3, g.rung)
        // This video has two rungs: it plays its bottom one (QualityLadder.index clamps)...
        assertEquals(3, g.onTrackStarted(9 * min, slow, listOf(128_000, 48_000)))
        assertEquals(1, QualityLadder.index(2, g.rung))
        // ...and the next four-rung video is still at rung 4, not two rungs up.
        assertEquals(3, g.onTrackStarted(10 * min, slow, ladder))
        // A step up from there is one rung.
        assertEquals(2, g.onTrackStarted(16 * min, fast, ladder))
    }

    @Test
    fun aStepUpOnAShortLadderIsOneRungForTheNextVideoToo() {
        val g = QualityGovernor()
        stall(g, 0L)
        g.onTrackStarted(0L, slow, ladder)
        stall(g, 3 * min)
        g.onTrackStarted(3 * min, slow, ladder)
        stall(g, 6 * min)
        g.onTrackStarted(6 * min, slow, ladder)
        assertEquals(3, g.rung)
        g.onTrackStarted(7 * min, slow, ladder)
        // Calm and fast on a three-rung video (plays its rung 3): one rung up from where it stood.
        assertEquals(2, g.onTrackStarted(12 * min, fast, listOf(160_000, 64_000, 48_000)))
        assertEquals(2, g.onTrackStarted(13 * min, fast, ladder))
    }

    @Test
    fun onlyBufferingWhilePlayingCountsAsARebuffer() {
        val d = RebufferDetector()
        // The first load: buffering without having been ready.
        assertFalse(d.onState(ready = false, buffering = true, playWhenReady = true, now = 0L))
        assertFalse(d.onState(ready = true, buffering = false, playWhenReady = true, now = 5 * sec))
        // Ran dry while playing.
        assertTrue(d.onState(ready = false, buffering = true, playWhenReady = true, now = 60 * sec))
        assertFalse(d.onState(ready = true, buffering = false, playWhenReady = true, now = 65 * sec))
        // Paused, then loading: not a stall anyone heard.
        assertFalse(d.onState(ready = false, buffering = true, playWhenReady = false, now = 90 * sec))
    }

    @Test
    fun aSeekSkipOrListChangeIsNoRebuffer() {
        val d = RebufferDetector()
        d.onState(ready = true, buffering = false, playWhenReady = true, now = 0L)
        // The user removed the playing track (or skipped, or seeked): the buffering is that jump's.
        d.onJump(10 * sec)
        assertFalse(d.onState(ready = false, buffering = true, playWhenReady = true, now = 11 * sec))
        d.onState(ready = true, buffering = false, playWhenReady = true, now = 12 * sec)
        // Long after the jump: a real stall again.
        assertTrue(d.onState(ready = false, buffering = true, playWhenReady = true, now = 13 * sec))
        assertEquals(2_000L, RebufferDetector.GRACE_MS)
    }
}
