package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.playback.NativeQueue.Section
import io.github.iamandelib.cyberjuke.playback.QueueRulesTest.FakePlayer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
    fun aRefreshedLinkKeepsTheSongPlayingInItsPlaceWithShuffleOn() {
        for (seed in 0L until 30L) {
            val p = player((0 until 8).map { "t$it" }, start = 2, shuffle = true, seed = seed)
            p.next()
            val playing = p.current
            val id = p.ids[playing]
            val up = p.upNext()
            val played = p.played()
            // The playing song gets another source (a fresh link, or its manifest).
            p.queue.replace(playing, id)
            assertEquals("seed $seed: still playing", playing, p.current)
            assertEquals("seed $seed: what's next is unchanged", up, p.upNext())
            assertEquals("seed $seed: what played is unchanged", played, p.played())
            // A song further on, the same: its place stays.
            val later = p.ids.indexOf(up[1])
            p.queue.replace(later, up[1])
            assertEquals("seed $seed", playing, p.current)
            assertEquals("seed $seed", up, p.upNext())
        }
    }

    @Test
    fun aRefreshedLinkKeepsTheSongPlayingWithShuffleOff() {
        val p = player(listOf("a", "b", "c", "d"), start = 1)
        p.queue.replace(1, "b")
        assertEquals(1, p.current)
        assertEquals(listOf("c", "d"), p.upNext())
    }

    @Test
    fun turningShuffleOnAgainShufflesAfresh() {
        for (seed in 0L until 20L) {
            val p = player((0 until 12).map { "t$it" }, start = 3, seed = seed)
            p.toggleShuffle(true)
            val first = p.upNext()
            p.toggleShuffle(false)
            p.toggleShuffle(true)
            val second = p.upNext()
            assertEquals("seed $seed: same tracks ahead", first.sorted(), second.sorted())
            assertNotEquals("seed $seed: a new order", first, second)
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
            // Autoplay stays last, mixed too with shuffle on.
            assertEquals("seed $seed: autoplay stays last", setOf("s1", "s2"), after.takeLast(2).toSet())
            // Without an anchor: after the list, before autoplay.
            p.queue.restore("y", Section.LIST, null)
            val last = p.upNext()
            assertEquals("seed $seed: $last", "y", last[last.size - 3])
            assertEquals("seed $seed: $last", setOf("s1", "s2"), last.takeLast(2).toSet())
        }
    }

    @Test
    fun shuffledAutoplayRestoreWithoutAnAnchorGoesLast() {
        for (seed in 0L until 20L) {
            val p = player(listOf("a", "b"), shuffle = true, seed = seed)
            p.queue.addAutoplay(listOf("s1", "s2", "s3", "s4", "s5"))
            p.queue.restore("z", Section.AUTO, null)
            assertEquals("seed $seed: ${p.upNext()}", "z", p.upNext().last())
        }
    }

    @Test
    fun aBatchAfterTheEndKeepsThePlayingOneAndTheOthersAhead() {
        // PlaybackService goes on to a batch added after the end while it is being added.
        for (seed in 0L until 40L) {
            val p = player(listOf("a", "b", "c"), shuffle = true, seed = seed)
            repeat(3) { p.nextAuto() }
            assertTrue(p.ended)
            p.onTimeline = { if (p.ended) p.next() }
            p.queue.addAutoplay(listOf("s1", "s2", "s3", "s4"))
            val cur = p.ids[p.current]
            assertTrue("seed $seed: $cur", cur.startsWith("s"))
            assertEquals("seed $seed: ${p.upNext()}", setOf("s1", "s2", "s3", "s4") - cur, p.upNext().toSet())
        }
    }

    @Test
    fun whatWasHeardIsForgottenOnceItIsGone() {
        val p = player(listOf("a", "b", "c", "d"))
        p.next()
        p.next()
        assertEquals(3, p.queue.heardUids.size)
        p.remove(0)
        assertEquals(2, p.queue.heardUids.size)
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
