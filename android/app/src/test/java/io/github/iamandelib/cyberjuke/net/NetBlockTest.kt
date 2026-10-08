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
    fun ladderIsTwoFiveFifteenSixtyMinutes() {
        val s = BlockState()
        var now = 1_000_000L
        val steps = ArrayList<Long>()
        repeat(6) {
            val until = s.trip(BlockReason.BOT_CHECK, now)!!
            steps.add((until - now) / min)
            now = until // the back-off ran out; the next attempt fails again
        }
        assertEquals(listOf(2L, 5L, 15L, 60L, 60L, 60L), steps)
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
    fun successResetsTheLadder() {
        val s = BlockState()
        val until = s.trip(BlockReason.BOT_CHECK, 0L)!!
        assertTrue(s.isBlocked(until - 1))
        assertFalse(s.isBlocked(until))
        // Ran out, nothing succeeded yet: still quiet (no prefetching).
        assertTrue(s.isQuiet(until))
        assertTrue(s.success())
        assertFalse(s.isQuiet(until))
        assertFalse(s.success()) // nothing to announce twice
        assertEquals(2 * min, s.trip(BlockReason.BOT_CHECK, 10 * min)!! - 10 * min)
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
        val events = ArrayList<String>()
        NetBlock.add(object : NetBlock.Listener {
            override fun onBlocked(until: Long, reason: BlockReason) {
                events.add("blocked $until $reason")
            }

            override fun onUnblocked() {
                events.add("unblocked")
            }
        })
        NetBlock.trip(BlockReason.BOT_CHECK)
        NetBlock.trip(BlockReason.BOT_CHECK) // already blocked: silent
        try {
            NetBlock.check()
            fail("expected BlockedException")
        } catch (e: BlockedException) {
            assertEquals(BlockReason.BOT_CHECK, e.reason)
        }
        now = 2 * min
        NetBlock.check() // ran out: extraction may try once
        NetBlock.success()
        NetBlock.success()
        assertEquals(listOf("blocked ${2 * min} BOT_CHECK", "unblocked"), events)
    }
}
