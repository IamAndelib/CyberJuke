package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OfflineNextTest {
    /** List order over [n] items, ending after the last (repeat off). */
    private fun inOrder(n: Int): (Int) -> Int = { i -> if (i + 1 < n) i + 1 else -1 }

    /** List order over [n] items, wrapping round (repeat all). */
    private fun wrapping(n: Int): (Int) -> Int = { i -> (i + 1) % n }

    @Test
    fun skipsTheSongsNotSaved() {
        assertEquals(3, OfflineNext.target(0, 5, inOrder(5)) { it == 3 })
    }

    @Test
    fun theNextSongWhenItIsSaved() {
        assertEquals(1, OfflineNext.target(0, 5, inOrder(5)) { it == 1 || it == 3 })
    }

    @Test
    fun wrapsRoundWhenTheOrderDoes() {
        assertEquals(1, OfflineNext.target(3, 4, wrapping(4)) { it == 1 })
    }

    @Test
    fun noneAfterTheEnd() {
        assertNull(OfflineNext.target(2, 5, inOrder(5)) { it == 1 })
    }

    @Test
    fun allUnsavedGivesNoneWithoutLooping() {
        assertNull(OfflineNext.target(0, 4, wrapping(4)) { false })
    }

    @Test
    fun theCurrentSongIsNeverItsOwnNext() {
        // Repeat all round to where it started: only the current one is saved.
        assertNull(OfflineNext.target(2, 4, wrapping(4)) { it == 2 })
    }

    @Test
    fun followsTheShuffleOrder() {
        val order = mapOf(0 to 3, 3 to 1, 1 to 2, 2 to -1)
        assertEquals(2, OfflineNext.target(0, 4, { order.getValue(it) }) { it == 2 || it == 4 })
    }

    /** D13: offline, a song that can't play with a saved one ahead is passed over (the queue doesn't hear it). */
    @Test
    fun passesOverOnlyASongThatCantPlayOfflineWithASavedOneAhead() {
        assertTrue(OfflineNext.passesOver(online = false, playable = false) { true })
        assertFalse("saved, or on the phone: it plays", OfflineNext.passesOver(online = false, playable = true) { true })
        assertFalse("none saved ahead: it waits for the network, and plays then", OfflineNext.passesOver(online = false, playable = false) { false })
        assertFalse("online", OfflineNext.passesOver(online = true, playable = false) { error("not asked online") })
    }
}
