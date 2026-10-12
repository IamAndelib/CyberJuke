package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QualityGovernorTest {
    private val min = 60_000L
    private val sec = 1_000L
    private val ladder = listOf(160_000, 128_000, 64_000, 48_000)

    /** Two rebuffers just before [at]: the next track steps down. */
    private fun stall(g: QualityGovernor, at: Long) {
        g.onRebuffer(at - 20 * sec)
        g.onRebuffer(at - 10 * sec)
    }

    /** Stalls at 0, 3 and 6 min: down to the bottom of [ladder]. */
    private fun toTheBottom(g: QualityGovernor) {
        for (t in listOf(0L, 3 * min, 6 * min)) {
            stall(g, t)
            g.onTrackStarted(t, ladder)
        }
        assertEquals(3, g.rung)
    }

    @Test
    fun startsAtTheTopAndStaysThereWithoutStalls() {
        val g = QualityGovernor()
        assertEquals(0, g.rung)
        var now = 0L
        repeat(10) {
            assertEquals(0, g.onTrackStarted(now, ladder))
            now += 4 * min
        }
    }

    @Test
    fun twoRebuffersWithinThreeMinutesStepDownOneRung() {
        val g = QualityGovernor()
        g.onTrackStarted(0L, ladder)
        g.onRebuffer(1 * min)
        // One rebuffer is no pattern.
        assertEquals(0, g.onTrackStarted(2 * min, ladder))
        g.onRebuffer(3 * min)
        assertEquals(1, g.onTrackStarted(4 * min, ladder))
        // Those rebuffers were answered by that step: not counted again.
        assertEquals(1, g.onTrackStarted(5 * min, ladder))
        // Stalling on: one rung per track, never straight to the bottom.
        stall(g, 6 * min)
        assertEquals(2, g.onTrackStarted(6 * min, ladder))
        stall(g, 7 * min)
        assertEquals(3, g.onTrackStarted(7 * min, ladder))
        stall(g, 8 * min)
        assertEquals(3, g.onTrackStarted(8 * min, ladder))
    }

    @Test
    fun rebuffersFurtherApartOrLongAgoDoNot() {
        val g = QualityGovernor()
        g.onTrackStarted(0L, ladder)
        g.onRebuffer(1 * min)
        g.onRebuffer(5 * min) // four minutes apart
        assertEquals(0, g.onTrackStarted(6 * min, ladder))
        val h = QualityGovernor()
        h.onTrackStarted(0L, ladder)
        h.onRebuffer(1 * min)
        h.onRebuffer(2 * min)
        // Both more than three minutes before this track: over.
        assertEquals(0, h.onTrackStarted(6 * min, ladder))
    }

    @Test
    fun upOneRungAfterFiveMinutesWithoutAStall() {
        val g = QualityGovernor()
        stall(g, 0L)
        g.onTrackStarted(0L, ladder) // down to 1
        stall(g, 3 * min)
        g.onTrackStarted(3 * min, ladder) // down to 2 at 3 min
        // No estimate needed or used: five calm minutes since the last step.
        assertEquals(2, g.onTrackStarted(6 * min, ladder))
        assertEquals(2, g.onTrackStarted(8 * min - 1, ladder))
        assertEquals(1, g.onTrackStarted(8 * min, ladder))
        // The next step up waits five minutes again: recovery takes several tracks.
        assertEquals(1, g.onTrackStarted(12 * min, ladder))
        assertEquals(0, g.onTrackStarted(13 * min, ladder))
        // At the top: nowhere to go.
        assertEquals(0, g.onTrackStarted(30 * min, ladder))
    }

    @Test
    fun aRebufferRestartsTheCalmBeforeAStepUp() {
        val g = QualityGovernor()
        stall(g, 0L)
        g.onTrackStarted(0L, ladder) // rung 1
        g.onRebuffer(4 * min)
        assertEquals(1, g.onTrackStarted(6 * min, ladder))
        assertEquals(1, g.onTrackStarted(8 * min, ladder))
        assertEquals(0, g.onTrackStarted(9 * min, ladder))
    }

    @Test
    fun noReversalWithinTwoTracksOfAStep() {
        val g = QualityGovernor()
        stall(g, 0L)
        g.onTrackStarted(0L, ladder) // down to 1
        // A long track: five calm minutes, but only one track since the step.
        assertEquals(1, g.onTrackStarted(6 * min, ladder))
        // The second track since: up again...
        assertEquals(0, g.onTrackStarted(10 * min, ladder))
        // ...and stalls right after that step don't reverse it.
        stall(g, 11 * min)
        assertEquals(0, g.onTrackStarted(11 * min, ladder))
        // Two tracks on, stalls step down again.
        stall(g, 12 * min)
        assertEquals(1, g.onTrackStarted(12 * min, ladder))
    }

    @Test
    fun aSingleRungOrNoLadderChangesNothing() {
        val g = QualityGovernor()
        // A single rung (or no ladder: a fallback stream) has nowhere to step.
        stall(g, 1 * min)
        assertEquals(0, g.onTrackStarted(1 * min, listOf(128_000)))
        assertEquals(0, g.onTrackStarted(2 * min, emptyList()))
    }

    @Test
    fun aShorterLadderPlaysItsBottomAndLeavesTheRungAsItWas() {
        val g = QualityGovernor()
        toTheBottom(g)
        // This video has two rungs: it plays its bottom one (QualityLadder.index clamps)...
        stall(g, 7 * min)
        assertEquals(3, g.onTrackStarted(7 * min, listOf(128_000, 48_000)))
        assertEquals(1, QualityLadder.index(2, g.rung))
        // ...and the next four-rung video is still at rung 4, not two rungs up.
        assertEquals(3, g.onTrackStarted(8 * min, ladder))
        // A step up from there is one rung.
        assertEquals(2, g.onTrackStarted(13 * min, ladder))
    }

    @Test
    fun aStepUpOnAShortLadderIsOneRungForTheNextVideoToo() {
        val g = QualityGovernor()
        toTheBottom(g)
        g.onTrackStarted(7 * min, ladder)
        // Calm on a three-rung video (plays its rung 3): one rung up from where it stood.
        assertEquals(2, g.onTrackStarted(12 * min, listOf(160_000, 64_000, 48_000)))
        assertEquals(2, g.onTrackStarted(13 * min, ladder))
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
