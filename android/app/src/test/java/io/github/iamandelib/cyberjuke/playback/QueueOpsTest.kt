package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.playback.NativeQueue.Section
import io.github.iamandelib.cyberjuke.playback.QueueRulesTest.FakePlayer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

/** Native-only queue operations beyond the shared rule table: shuffle, trimming, edge cases. */
class QueueOpsTest {

    private fun player(list: List<String>, start: Int = 0, shuffle: Boolean = false, seed: Long = 0L) =
        FakePlayer(Random(seed)).apply {
            this.shuffle = shuffle
            queue.setList(list, start)
        }

    private fun section(p: FakePlayer, id: String): Section {
        val i = p.ids.indexOf(id)
        return when {
            p.serials[i] in p.queue.pendingSerials -> Section.QUEUED
            p.auto[i] -> Section.AUTO
            else -> Section.LIST
        }
    }

    @Test
    fun shuffledListRestoreGoesBeforeItsAnchorInPlayOrder() {
        for (seed in 0L until 40L) {
            val p = player(listOf("a", "b", "c", "d", "e", "f"), shuffle = true, seed = seed)
            p.queue.addAutoplay(listOf("s1", "s2"))
            val up = p.upNext()
            val listAhead = up.filter { section(p, it) == Section.LIST }
            val anchor = listAhead[2]
            p.queue.restore("z", Section.LIST, anchor)
            val after = p.upNext()
            assertEquals("seed $seed: $after", after.indexOf(anchor) - 1, after.indexOf("z"))
            assertEquals("seed $seed", Section.LIST, section(p, "z"))
            assertEquals("seed $seed: autoplay stays last", listOf("s1", "s2"), after.takeLast(2))
            // Without an anchor: after the list, before autoplay.
            p.queue.restore("y", Section.LIST, null)
            val last = p.upNext()
            assertEquals("seed $seed: $last", listOf("y", "s1", "s2"), last.takeLast(3))
        }
    }

    @Test
    fun shuffledQueuedRestoreStaysInTheQueuedRun() {
        for (seed in 0L until 20L) {
            val p = player(listOf("a", "b", "c", "d"), shuffle = true, seed = seed)
            p.queue.queueNext(listOf("X", "Z"))
            p.queue.restore("Y", Section.QUEUED, "Z")
            assertEquals("seed $seed", listOf("X", "Y", "Z"), p.upNext().take(3))
            p.queue.restore("W", Section.QUEUED, "b") // anchor in another section: end of the run
            assertEquals("seed $seed", listOf("X", "Y", "Z", "W"), p.upNext().take(4))
        }
    }

    @Test
    fun aRestoreWithAStaleAnchorBehindTheCurrentTrackGoesAhead() {
        val p = player(listOf("a", "b", "c"), start = 2)
        p.queue.restore("z", Section.LIST, "a") // "a" already played
        assertEquals(listOf("z"), p.upNext())
        assertEquals(listOf("a", "b", "c", "z"), p.ids.toList())
    }

    @Test
    fun removeIdsInShuffleMovesOnInPlayOrder() {
        for (seed in 0L until 20L) {
            val p = player(listOf("a", "m1", "b", "m2", "c"), start = 1, shuffle = true, seed = seed)
            val expected = p.upNext().first { it != "m2" }
            val r = p.queue.removeIds(setOf("m1", "m2"))
            assertEquals(2, r.removed)
            assertFalse(r.stopped)
            assertEquals("seed $seed", expected, p.ids[p.current])
            assertFalse(p.ids.contains("m1") || p.ids.contains("m2"))
        }
    }

    @Test
    fun removeIdsStopsWhenNothingAfterTheCurrentStays() {
        val p = player(listOf("a", "b", "m1", "m2"), start = 2)
        val r = p.queue.removeIds(setOf("m1", "m2"))
        assertTrue(r.stopped)
        assertEquals(listOf("a", "b"), p.ids.toList())
        // Unknown ids: nothing happens.
        assertEquals(NativeQueue.Removal(0, false), p.queue.removeIds(setOf("x")))
    }

    @Test
    fun playedAutoplayItemsAreTrimmedToTheLastFifty() {
        val p = player(listOf("a", "b"))
        p.queue.addAutoplay((1..80).map { "s$it" })
        repeat(1 + 61) { p.nextAuto() } // b, then s1..s61: 60 autoplay items played
        assertEquals("s61", p.ids[p.current])
        assertEquals(10, p.queue.trimPlayedAuto(50))
        assertEquals("s61", p.ids[p.current])
        // The list items and the 50 most recent played autoplay items stay, in order.
        assertEquals(listOf("a", "b") + (11..80).map { "s$it" }, p.ids.toList())
        assertEquals(0, p.queue.trimPlayedAuto(50))
        assertEquals((62..80).map { "s$it" }, p.upNext())
    }
}
