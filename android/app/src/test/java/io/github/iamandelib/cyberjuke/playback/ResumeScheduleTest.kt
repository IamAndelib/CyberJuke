package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.net.NetBlock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ResumeScheduleTest {
    private val sec = 1_000L
    private val min = 60_000L

    /** Runs every event the schedule asks for from an outage pause at [start]: the tries' times, then "end". */
    private fun tries(s: ResumeSchedule, start: Long): List<String> {
        s.onOutagePause(start)
        val at = ArrayList<String>()
        var now = start
        while (true) {
            val d = s.delayMs(now) ?: break
            now += d
            if (s.isOver(now)) {
                at.add("end ${(now - start) / sec}")
                break
            }
            at.add("${(now - start) / sec}")
            s.attempted(now)
        }
        return at
    }

    @Test
    fun nothingIsScheduledWithoutAnOutagePause() {
        val s = ResumeSchedule()
        assertFalse(s.active)
        assertNull(s.delayMs(0L))
        s.attempted(5L) // a stray try changes nothing
        assertNull(s.delayMs(5L))
    }

    @Test
    fun triesBackOffThenEveryTwoMinutesUntilTheWindowEnds() {
        // 15 s, 30 s and 60 s apart, then every 2 min, all within the 9-minute window; the
        // wait ends at the window's end, not at the last try (the network callback may still
        // resume until then).
        assertEquals(
            listOf("15", "45", "105", "225", "345", "465", "end 540"),
            tries(ResumeSchedule(), 1_000_000L),
        )
        assertEquals(9 * min, NetBlock.RESUME_WINDOW_MS)
    }

    @Test
    fun aTryThatFailsAgainCountsTheNextFromItsOwnPause() {
        val s = ResumeSchedule()
        s.onOutagePause(0L)
        assertEquals(15 * sec, s.delayMs(0L))
        s.attempted(15 * sec)
        // The load took a while to fail (retries): the next try is 30 s after that pause.
        s.onOutagePause(50 * sec)
        assertEquals(30 * sec, s.delayMs(50 * sec))
        // Asked late (the CPU slept): due at once, never negative.
        assertEquals(0L, s.delayMs(5 * min))
    }

    @Test
    fun theWindowCountsFromTheStreaksFirstPause() {
        val s = ResumeSchedule()
        s.onOutagePause(0L)
        repeat(4) { s.attempted((it + 1) * min) }
        // Paused again 8.5 min in: still the same streak; the next try would be past 9 min, so
        // what comes next is the window's end.
        s.onOutagePause(8 * min + 30 * sec)
        assertTrue(s.active)
        assertEquals(30 * sec, s.delayMs(8 * min + 30 * sec))
        assertFalse(s.isOver(9 * min - 1))
        assertTrue(s.isOver(9 * min))
        assertNull(s.delayMs(9 * min))
    }

    @Test
    fun aPauseLongAfterTheWindowStartsANewStreak() {
        val s = ResumeSchedule()
        s.onOutagePause(0L)
        repeat(5) { s.attempted((it + 1) * min) }
        val later = 20 * min
        s.onOutagePause(later)
        assertEquals(15 * sec, s.delayMs(later))
    }

    @Test
    fun stopEndsTheStreak() {
        val s = ResumeSchedule()
        s.onOutagePause(0L)
        assertTrue(s.active)
        s.stop()
        assertFalse(s.active)
        assertNull(s.delayMs(0L))
        // The next outage starts over with the first, shortest step.
        s.onOutagePause(10 * sec)
        assertEquals(15 * sec, s.delayMs(10 * sec))
    }

    @Test
    fun aShorterWindowEndsSooner() {
        assertEquals(listOf("15", "45", "end 60"), tries(ResumeSchedule(windowMs = min), 0L))
    }
}
