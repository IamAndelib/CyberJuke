package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TransitionWatchTest {
    private val seamless = TransitionWatch.Verdict.Seamless

    @Test
    fun aTransitionWithNoBufferingIsSeamlessAtTheDeadline() {
        val w = TransitionWatch()
        w.onAutoTransition(now = 10_000L, buffering = false)
        assertTrue(w.watching)
        assertEquals(seamless, w.onDeadline(10_000L + TransitionWatch.WINDOW_MS))
        assertFalse(w.watching)
        // Judged once.
        assertNull(w.onDeadline(12_000L))
        assertNull(w.onReady(12_000L))
    }

    @Test
    fun bufferingAfterTheTransitionIsAStallAsLongAsItTookToBeReady() {
        val w = TransitionWatch()
        w.onAutoTransition(now = 0L, buffering = false)
        w.onBuffering(100L)
        assertEquals(TransitionWatch.Verdict.Stalled(600L), w.onReady(700L))
        assertFalse(w.watching)
        assertNull(w.onDeadline(1_000L))
    }

    @Test
    fun stillBufferingAtTheDeadlineIsAStallOfThatLongSoFar() {
        val w = TransitionWatch()
        w.onAutoTransition(now = 0L, buffering = false)
        w.onBuffering(200L)
        assertEquals(TransitionWatch.Verdict.Stalled(800L), w.onDeadline(1_000L))
        // Ready later: already judged.
        assertNull(w.onReady(1_500L))
    }

    @Test
    fun aStallUnderWayAtTheTransitionCountsFromWhenItBegan() {
        // The connection ran dry at the end of this track; the player moves on while still buffering.
        val w = TransitionWatch()
        w.onBuffering(0L)
        w.onAutoTransition(now = 400L, buffering = true)
        assertEquals(TransitionWatch.Verdict.Stalled(900L), w.onReady(900L))
        // Nothing known about an earlier stall: from the transition.
        val v = TransitionWatch()
        v.onAutoTransition(now = 400L, buffering = true)
        assertEquals(TransitionWatch.Verdict.Stalled(500L), v.onReady(900L))
    }

    @Test
    fun aRebufferThatEndedBeforeTheTransitionDoesNotCount() {
        val w = TransitionWatch()
        w.onBuffering(0L)
        assertNull(w.onReady(300L))
        w.onAutoTransition(now = 1_000L, buffering = false)
        assertEquals(seamless, w.onDeadline(2_000L))
    }

    @Test
    fun aSeekOrASkipIsNoTransitionOfATracksOwn() {
        // The crossfade's hand-over is a seek too: never judged.
        val w = TransitionWatch()
        w.cancel()
        assertFalse(w.watching)
        w.onBuffering(10L)
        assertNull(w.onReady(300L))
        assertNull(w.onDeadline(1_000L))
        // A skip during a watch ends it without a verdict.
        w.onAutoTransition(now = 2_000L, buffering = false)
        w.cancel()
        assertFalse(w.watching)
        assertNull(w.onDeadline(3_000L))
        assertEquals(1_000L, TransitionWatch.WINDOW_MS)
    }
}
