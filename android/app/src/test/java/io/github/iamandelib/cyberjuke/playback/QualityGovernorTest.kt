package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Test

class QualityGovernorTest {
    private val min = 60_000L
    private val ladder = listOf(160_000, 128_000, 64_000, 48_000)

    /** Plenty for every rung (above 2.5 x the top), and too little for any (below 1.5 x the bottom). */
    private val fast = 10_000_000L
    private val slow = 50_000L

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
    fun aLowEstimateStepsDownOneRungPerTrack() {
        val g = QualityGovernor()
        // 200 kbps < 1.5 x 160: down one rung, not straight to the bottom.
        assertEquals(1, g.onTrackStarted(0L, 200_000L, ladder))
        // 180 kbps is under 1.5 x 128 too: down again at the next track.
        assertEquals(2, g.onTrackStarted(3 * min, 180_000L, ladder))
        // 100 kbps >= 1.5 x 64: the rung holds.
        assertEquals(2, g.onTrackStarted(6 * min, 100_000L, ladder))
        // Slower still: the bottom, and no further.
        assertEquals(3, g.onTrackStarted(9 * min, slow, ladder))
        assertEquals(3, g.onTrackStarted(12 * min, slow, ladder))
    }

    @Test
    fun twoRebuffersWithinThreeMinutesStepDown() {
        val g = QualityGovernor()
        g.onTrackStarted(0L, fast, ladder)
        g.onRebuffer(1 * min)
        // One rebuffer is no pattern.
        assertEquals(0, g.onTrackStarted(2 * min, fast, ladder))
        g.onRebuffer(3 * min)
        assertEquals(1, g.onTrackStarted(4 * min, fast, ladder))
        // Those rebuffers were answered by that step: not counted again.
        assertEquals(1, g.onTrackStarted(5 * min, fast, ladder))
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
        g.onTrackStarted(0L, 200_000L, ladder) // down to 1
        g.onTrackStarted(3 * min, 180_000L, ladder) // down to 2 at 3 min
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
        g.onTrackStarted(0L, 200_000L, ladder) // rung 1
        g.onRebuffer(4 * min)
        assertEquals(1, g.onTrackStarted(6 * min, fast, ladder))
        assertEquals(1, g.onTrackStarted(8 * min, fast, ladder))
        assertEquals(0, g.onTrackStarted(9 * min, fast, ladder))
    }

    @Test
    fun noReversalWithinTwoTracksOfAStep() {
        val g = QualityGovernor()
        g.onTrackStarted(0L, 200_000L, ladder) // down to 1
        // A long track: five calm minutes and a fast link, but only one track since the step.
        assertEquals(1, g.onTrackStarted(6 * min, fast, ladder))
        // The second track since: up again...
        assertEquals(0, g.onTrackStarted(10 * min, fast, ladder))
        // ...and a dip right after that step doesn't reverse it.
        assertEquals(0, g.onTrackStarted(11 * min, 200_000L, ladder))
        // Two tracks on, a slow link steps down again.
        assertEquals(1, g.onTrackStarted(12 * min, 200_000L, ladder))
    }

    @Test
    fun anUnknownEstimateOrLadderChangesNothing() {
        val g = QualityGovernor()
        assertEquals(0, g.onTrackStarted(0L, 0L, ladder))
        assertEquals(0, g.onTrackStarted(10 * min, -1L, ladder))
        // A single rung (or no ladder: a fallback stream) has nowhere to step.
        assertEquals(0, g.onTrackStarted(11 * min, slow, listOf(128_000)))
        assertEquals(0, g.onTrackStarted(12 * min, slow, emptyList()))
    }

    @Test
    fun aShorterLadderClampsTheRung() {
        val g = QualityGovernor()
        g.onTrackStarted(0L, 200_000L, ladder)
        g.onTrackStarted(3 * min, 180_000L, ladder)
        g.onTrackStarted(6 * min, slow, ladder)
        assertEquals(3, g.rung)
        // This video has two rungs: its bottom is where it stands.
        assertEquals(1, g.onTrackStarted(9 * min, slow, listOf(128_000, 48_000)))
    }
}
