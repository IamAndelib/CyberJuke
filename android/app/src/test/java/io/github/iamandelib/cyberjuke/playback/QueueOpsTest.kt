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

    /** A crossfade fades into where the loop lands (PlaybackService.fadeTarget): past a heard song you queued first in play order (S5). */
    @Test
    fun theLoopLandsPastAHeardSongYouQueued() {
        val p = player(listOf("a", "b", "c"))
        p.queue.queueNext(listOf("M"))
        p.next()
        p.next()
        p.remove(p.ids.indexOf("a"))
        val (m, b, c) = listOf("M", "b", "c").map { p.ids.indexOf(it) }
        assertEquals("Repeat off: no loop", m, p.queue.landing(m))
        p.repeat = "all"
        p.queue.onRepeatModeChanged(true)
        assertEquals("ahead: where it is", c, p.queue.landing(c))
        p.next()
        assertEquals("the loop: the first song that stays", b, p.queue.landing(m))
        assertEquals("the loop onto a song that stays: there", b, p.queue.landing(b))
        assertEquals("none", -1, p.queue.landing(-1))
        // Media3's own loop onto M: the queue moves on to b itself, and says so (PlaybackService leaves the rest to that move).
        p.current = m
        assertTrue(p.queue.onTransition(forward = true))
        assertEquals("b", p.ids[p.current])
        assertEquals(listOf("b", "c"), p.ids)
        p.current = p.ids.indexOf("c")
        assertFalse(p.queue.onTransition(forward = true))
    }

    @Test
    fun aCrossfadeIntoTheLoopOntoThePlayingSongStillLoops() {
        // Only the playing song stays at the loop: the fade lands on it, and the hand-over's move onto it is the loop.
        val p = player(listOf("a", "c"))
        p.queue.queueNext(listOf("M"))
        p.next()
        p.next()
        p.remove(p.ids.indexOf("a"))
        p.repeat = "all"
        p.queue.onRepeatModeChanged(true)
        val c = p.ids.indexOf("c")
        assertEquals(c, p.queue.landing(p.ids.indexOf("M")))
        p.current = c
        p.queue.onTransition(forward = true)
        assertEquals(listOf("c"), p.ids)
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

    /** A list on the way can repeat ids (Home's Shuffle's next round, a station coming round again): Undo goes back before the song that followed it, by its index, not before another copy (S10). */
    @Test
    fun restoreGoesBeforeTheSongThatFollowedItNotAnotherCopy() {
        val p = player(listOf("x1", "x2", "x3"))
        p.queue.addAutoplay(listOf("x3", "x2", "x1"))
        val way = p.queue.nextStartIndex()
        p.remove(way) // the next round's x2 followed it, and now has its index
        p.queue.restore("x3", Section.AUTO, "x2", beforeIndex = way)
        assertEquals(listOf("x2", "x3", "x3", "x2", "x1"), p.upNext())
        assertTrue(p.auto[3] && p.queue.nextStartIndex() == 3)
    }

    /** The list's copy of a song back gives the list on the way no marker back, though the copy on the way that held it went too (F10). */
    @Test
    fun restoreOfTheListsCopyLeavesTheListOnTheWayAlone() {
        val p = player(listOf("x1", "x2", "x3"))
        p.queue.addAutoplay(listOf("x3", "x2", "x1"))
        p.remove(3) // the next round's x3, the first on the way: its x2 starts it now
        p.remove(2) // the list's x3
        p.queue.restore("x3", Section.LIST, "x2", beforeIndex = 2)
        assertEquals(listOf("x1", "x2", "x3", "x2", "x1"), p.ids.toList())
        assertEquals(3, p.queue.nextStartIndex())
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
    fun shuffledMovingASongYouQueuedLeavesTheListSongsInTheirMixedOrder() {
        for (seed in 0L until 20L) {
            val p = player(listOf("a", "b", "c", "d", "e"), shuffle = true, seed = seed)
            p.queue.queueNext(listOf("x", "y", "z"))
            val rest = p.upNext().drop(3)
            p.queue.move(3, 1)
            p.queue.move(2, 3)
            assertEquals("seed $seed", listOf("z", "y", "x") + rest, p.upNext())
        }
    }

    @Test
    fun shuffledMovingASongYouQueuedPastListSongsLeavesThemAndPlayedInPlace() {
        for (seed in 0L until 30L) {
            // A jump back leaves X where it was in the list, so the move goes past list songs and the played one.
            val p = player(listOf("a", "b", "c", "d", "e"), start = 4, shuffle = true, seed = seed)
            p.queue.queueNext(listOf("X"))
            p.queue.skipTo(p.ids.indexOf("a"))
            p.queue.queueNext(listOf("Y"))
            val (played, rest) = p.played() to p.upNext().drop(2)
            p.queue.move(p.ids.indexOf("X"), p.ids.indexOf("Y"))
            assertEquals("seed $seed", listOf("Y", "X") + rest, p.upNext())
            assertEquals("seed $seed", played, p.played())
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
        p.queue.addAutoplay((1..80).map { "s$it" }, joinList = true)
        repeat(1 + 61) { p.nextAuto() } // b, then s1..s61: 60 autoplay items played
        assertEquals("s61", p.ids[p.current])
        assertEquals(10, p.queue.trimPlayedAuto(50))
        assertEquals("s61", p.ids[p.current])
        // The list items and the 50 most recent played autoplay items stay, in order.
        assertEquals(listOf("a", "b") + (11..80).map { "s$it" }, p.ids.toList())
        assertEquals(0, p.queue.trimPlayedAuto(50))
        assertEquals((62..80).map { "s$it" }, p.upNext())
    }

    @Test
    fun theTrimLeavesTheCurrentList() {
        val p = player(listOf("a", "b"))
        p.queue.addAutoplay((1..80).map { "s$it" })
        repeat(1 + 61) { p.nextAuto() }
        assertEquals(0, p.queue.trimPlayedAuto(50))
        assertEquals(2, p.queue.listStartIndex())
        assertEquals(listOf("a", "b") + (1..80).map { "s$it" }, p.ids.toList())
    }

    @Test
    fun shuffledTheTrimLeavesTheCurrentListToo() {
        for (seed in 0L until 10L) {
            val p = player(listOf("a", "b"), shuffle = true, seed = seed)
            p.queue.addAutoplay((1..80).map { "s$it" })
            repeat(1 + 61) { p.nextAuto() }
            // The list starts at its first song in list order, whichever played first, and keeps all of it.
            assertEquals("seed $seed", "s1", p.ids[p.queue.listStartIndex()])
            assertEquals("seed $seed", 0, p.queue.trimPlayedAuto(50))
        }
    }

    @Test
    fun aRemovedMarkerPassesToTheNextSongThatStays() {
        val p = player(listOf("a", "b"))
        p.queue.addAutoplay(listOf("s1", "s2", "s3"))
        p.remove(p.ids.indexOf("s1"))
        assertEquals("s2", p.ids[p.queue.nextStartIndex()])
        p.remove(p.ids.indexOf("s3"))
        p.remove(p.ids.indexOf("s2"))
        assertEquals(-1, p.queue.nextStartIndex())
        p.queue.addAutoplay(listOf("t1"))
        p.queue.dropOnTheWay()
        assertEquals(-1, p.queue.nextStartIndex())
    }

    @Test
    fun aRestoredSessionKeepsTheQueuedByYouMark() {
        // After Previous, m (queued by you, heard) is ahead again; q was queued since and waits.
        val p = FakePlayer(Random(1))
        val ids = listOf("a", "q", "m", "b")
        val sections = listOf(Section.LIST, Section.QUEUED, Section.LIST, Section.LIST)
        p.queue.restoreSession(ids, sections, 0, 0L, null, listOf(true, false, true, false), mine = listOf(false, true, true, false))
        assertEquals(listOf("q", "m"), p.ids.filterIndexed { i, _ -> p.serials[i] != 0L })
        // Only q is still queued: m has played, so it stays a list song (R2).
        assertEquals(setOf(p.serials[1]), p.queue.pendingSerials)
        assertEquals(listOf("q", "m", "b"), p.upNext())
        // The current song keeps its mark too.
        val c = FakePlayer(Random(1))
        c.queue.restoreSession(listOf("m", "a"), listOf(Section.LIST, Section.LIST), 0, 0L, null, mine = listOf(true, false))
        assertNotEquals(0L, c.serials[0])
        assertTrue(c.queue.pendingSerials.isEmpty())
    }

    @Test
    fun aRadiosFirstBatchJoinsItsListUnderRepeatAll() {
        val p = player(listOf("a"))
        p.repeat = "all"
        p.queue.onRepeatModeChanged(true)
        p.queue.addAutoplay(listOf("s1", "s2"), joinList = true)
        assertEquals(-1, p.queue.nextStartIndex())
        assertEquals(0, p.queue.listStartIndex())
        assertEquals(listOf("a", "s1", "s2"), p.ids)
        // Without joinList it would be on the way (the bug this guards: a gate that let it in without it).
        val q = player(listOf("a"))
        q.queue.addAutoplay(listOf("s1", "s2"))
        assertEquals(1, q.queue.nextStartIndex())
    }

    /** Offline, a song ends onto one that can't play: PlaybackService passes it over to the next saved one, unheard (D13, final QA C4). */
    @Test
    fun aSongPassedOverOfflineIsNotHeard() {
        val p = player(listOf("a", "b", "c", "d"))
        p.queue.queueNext(listOf("M"))
        p.passing = { it == "M" || it == "b" }
        p.nextAuto() // onto M, which can't play
        p.seekForward(p.ids.indexOf("c")) // past b too, to the saved c
        assertEquals("not in Played", listOf("a"), p.played())
        assertEquals("not heard", listOf("a", "c"), p.ids.filter { p.uids[p.ids.indexOf(it)] in p.queue.heardUids })
        assertTrue("not remembered for Save", p.queue.heardMine.none { it.id == "M" })
        assertEquals("the song you queued still comes next", listOf("M", "d"), p.upNext())
        assertEquals(1, p.queue.pendingSerials.size)
    }

    /** One passed over that loads after all (the network came back before its error) is heard once ready. */
    @Test
    fun aSongPassedOverThatPlaysAfterAllIsHeard() {
        val p = player(listOf("a", "b", "c"))
        p.passing = { it == "b" }
        p.nextAuto()
        p.passing = { false }
        p.queue.onReady()
        p.nextAuto()
        assertEquals(listOf("a", "b"), p.played())
        // A song you queued passed over, then played after all, no longer waits.
        val q = player(listOf("a", "b"))
        q.queue.queueNext(listOf("M"))
        q.passing = { it == "M" }
        q.nextAuto()
        q.passing = { false }
        q.queue.onReady()
        assertTrue(q.queue.pendingSerials.isEmpty())
    }

    /** Repeat all's loop onto a song that can't play: the new lap starts with the saved one after it. */
    @Test
    fun aSongPassedOverAtTheLoopIsNotHeardThisLap() {
        val p = player(listOf("a", "b", "c"))
        p.repeat = "all"
        p.queue.onRepeatModeChanged(true)
        p.nextAuto()
        p.nextAuto()
        p.passing = { it == "a" }
        p.nextAuto() // the loop, onto a
        p.seekForward(p.ids.indexOf("b"))
        assertEquals(setOf(p.uids[p.ids.indexOf("b")]), p.queue.lapUids)
    }
}
