package io.github.iamandelib.cyberjuke.net

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class NetBlockTest {
    private val min = 60_000L

    @After
    fun reset() = NetBlock.resetForTest()

    @Test
    fun ladderIsOneThreeTenThirtyMinutes() {
        val s = BlockState()
        var now = 1_000_000L
        val steps = ArrayList<Long>()
        repeat(6) {
            val until = s.trip(BlockReason.BOT_CHECK, now)!!
            steps.add((until - now) / min)
            now = until // the back-off ran out; the next attempt fails again
        }
        assertEquals(listOf(1L, 3L, 10L, 30L, 30L, 30L), steps)
    }

    @Test
    fun theLadderRelaxesOneStepPerHalfHourWithoutABlock() {
        val s = BlockState()
        var now = 0L
        repeat(3) { now = s.trip(BlockReason.BOT_CHECK, now)!! } // 1, 3, 10: next would be 30
        // 30 minutes clean: one step down (10 again); 60 minutes: two steps (3).
        assertEquals(10 * min, s.trip(BlockReason.BOT_CHECK, now + 30 * min)!! - (now + 30 * min))
        val s2 = BlockState()
        now = 0L
        repeat(3) { now = s2.trip(BlockReason.BOT_CHECK, now)!! }
        assertEquals(3 * min, s2.trip(BlockReason.BOT_CHECK, now + 60 * min)!! - (now + 60 * min))
        // At the top (30 minutes), half an hour clean relaxes one step too: 10, not 30 again.
        val top = BlockState()
        now = 0L
        repeat(5) { now = top.trip(BlockReason.BOT_CHECK, now)!! }
        assertEquals(10 * min, top.trip(BlockReason.BOT_CHECK, now + 30 * min)!! - (now + 30 * min))
        // Hours later: back to the bottom.
        val s3 = BlockState()
        now = 0L
        repeat(4) { now = s3.trip(BlockReason.BOT_CHECK, now)!! }
        assertEquals(1 * min, s3.trip(BlockReason.BOT_CHECK, now + 5 * 60 * min)!! - (now + 5 * 60 * min))
    }

    @Test
    fun tripWhileBlockedDoesNotEscalate() {
        val s = BlockState()
        val until = s.trip(BlockReason.RATE_LIMIT, 0L)!!
        assertNull(s.trip(BlockReason.BOT_CHECK, until - 1))
        assertEquals(until, s.snapshot().until)
        assertEquals(BlockReason.RATE_LIMIT, s.snapshot().reason)
        assertEquals(1, s.snapshot().level)
    }

    @Test
    fun successEndsTheQuietButKeepsTheLadder() {
        val s = BlockState()
        val until = s.trip(BlockReason.BOT_CHECK, 0L)!!
        assertTrue(s.isBlocked(until - 1))
        assertFalse(s.isBlocked(until))
        // Ran out, nothing succeeded yet: still quiet (no prefetching).
        assertTrue(s.isQuiet(until))
        assertFalse(s.success(until - 1)) // during the back-off: proves nothing
        assertTrue(s.success(until))
        assertFalse(s.isQuiet(until))
        assertFalse(s.success(until)) // nothing to announce twice
        // Let through once and refused again right after: the next step, not 1 minute again.
        assertEquals(3 * min, s.trip(BlockReason.BOT_CHECK, until + min)!! - (until + min))
    }

    @Test
    fun resetLiftsABackOffAtOnce() {
        val s = BlockState()
        val until = s.trip(BlockReason.BOT_CHECK, 0L)!!
        assertTrue(s.reset(10L, keepLevel = true))
        assertFalse(s.isBlocked(10L))
        assertFalse(s.reset(11L, keepLevel = true)) // nothing running: nothing to announce
        // "Try now" keeps the ladder: refused again, the next step.
        assertEquals(3 * min, s.trip(BlockReason.BOT_CHECK, 20L)!! - 20L)
        // A new network starts over.
        assertTrue(s.reset(30L, keepLevel = false))
        assertEquals(1 * min, s.trip(BlockReason.BOT_CHECK, 40L)!! - 40L)
        assertTrue(until > 0)
    }

    @Test
    fun aRequestThatSucceedsDuringABackOffDoesNotEndIt() {
        var now = 0L
        NetBlock.clock = { now }
        NetBlock.trip(BlockReason.BOT_CHECK)
        // An extraction that started before the trip finishes fine: still blocked and quiet.
        NetBlock.requestSucceeded()
        assertTrue(NetBlock.isBlocked())
        now = 2 * min
        assertTrue(NetBlock.isQuiet())
        NetBlock.requestSucceeded()
        assertFalse(NetBlock.isQuiet())
    }

    @Test
    fun aMusicBlockLeavesPlaybackAlone() {
        var now = 0L
        NetBlock.clock = { now }
        val events = recordEvents()
        NetBlock.trip(BlockReason.BOT_CHECK, Surface.MUSIC)
        assertTrue(NetBlock.isBlocked(Surface.MUSIC))
        assertFalse(NetBlock.isBlocked(Surface.PLAYBACK))
        NetBlock.check(Surface.PLAYBACK) // no throw: streams still resolve
        try {
            NetBlock.check(Surface.MUSIC)
            fail("expected BlockedException")
        } catch (e: BlockedException) {
            assertEquals(Surface.MUSIC, e.surface)
        }
        assertEquals(emptyList<String>(), events) // no banner for a music-only block
        assertEquals(Surface.MUSIC, NetBlock.lastLimit?.surface)
        // A playback block holds the music features too (the same IP).
        NetBlock.trip(BlockReason.RATE_LIMIT, Surface.PLAYBACK)
        assertEquals(BlockReason.RATE_LIMIT, NetBlock.active(Surface.MUSIC).second)
        now = 10 * min
        assertFalse(NetBlock.isBlocked(Surface.MUSIC))
    }

    @Test
    fun resetLiftsBothSurfacesAndAnnouncesTheEnd() {
        NetBlock.clock = { 0L }
        val events = recordEvents()
        NetBlock.trip(BlockReason.BOT_CHECK)
        NetBlock.trip(BlockReason.BOT_CHECK, Surface.MUSIC)
        NetBlock.reset(keepLevel = false)
        assertFalse(NetBlock.isBlocked(Surface.MUSIC))
        assertEquals(listOf("blocked $min BOT_CHECK", "unblocked"), events)
    }

    @Test
    fun resumeIsWantedOnlyWithinItsWindow() {
        var now = 0L
        NetBlock.clock = { now }
        assertFalse(NetBlock.takeResume())
        NetBlock.wantResume()
        assertTrue(NetBlock.resumePending())
        assertTrue(NetBlock.takeResume())
        assertFalse(NetBlock.takeResume()) // once
        NetBlock.wantResume()
        NetBlock.cancelResume()
        assertFalse(NetBlock.takeResume())
        NetBlock.wantResume()
        now = NetBlock.RESUME_WINDOW_MS + 1
        assertFalse(NetBlock.takeResume()) // too late: no surprise music
    }

    @Test
    fun activeReportsUntilAndReasonOnlyWhileBlocked() {
        val s = BlockState()
        assertEquals(0L to null, s.active(5L))
        val until = s.trip(BlockReason.STREAM_FORBIDDEN, 5L)!!
        assertEquals(until to BlockReason.STREAM_FORBIDDEN, s.active(6L))
        assertEquals(0L to null, s.active(until))
    }

    @Test
    fun listenersHearStartsAndTheEnd() {
        var now = 0L
        NetBlock.clock = { now }
        val events = recordEvents()
        NetBlock.trip(BlockReason.BOT_CHECK)
        NetBlock.trip(BlockReason.BOT_CHECK) // already blocked: silent
        try {
            NetBlock.check()
            fail("expected BlockedException")
        } catch (e: BlockedException) {
            assertEquals(BlockReason.BOT_CHECK, e.reason)
        }
        now = min
        NetBlock.check() // ran out: extraction may try once
        NetBlock.requestSucceeded()
        NetBlock.requestSucceeded()
        assertEquals(listOf("blocked $min BOT_CHECK", "unblocked"), events)
    }

    private fun recordEvents(): MutableList<String> {
        val events = ArrayList<String>()
        NetBlock.add(object : NetBlock.Listener {
            override fun onBlocked(until: Long, reason: BlockReason) {
                events.add("blocked $until $reason")
            }

            override fun onUnblocked() {
                events.add("unblocked")
            }
        })
        return events
    }
}
