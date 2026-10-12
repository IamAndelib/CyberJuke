package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CrossfadeTest {
    private val min = 60_000L

    private fun facts(
        settingMs: Long = 6_000L,
        playing: Boolean = true,
        repeatOne: Boolean = false,
        hasNext: Boolean = true,
        outage: Boolean = false,
        ours: Boolean = true,
        durationMs: Long = 4 * min,
        positionMs: Long = 3 * min,
        nextDurationMs: Long = 3 * min,
        nextBufferedMs: Long = 3 * min,
    ) = CrossfadePlan.Facts(settingMs, playing, repeatOne, hasNext, outage, ours, durationMs, positionMs, nextDurationMs, nextBufferedMs)

    // ---- CrossfadePlan --------------------------------------------------------------------

    @Test
    fun theChoicesAreOffAndThreeLengths() {
        assertEquals(listOf(0, 3_000, 6_000, 10_000), CrossfadePlan.CHOICES_MS)
        for (ms in CrossfadePlan.CHOICES_MS) assertEquals(ms, CrossfadePlan.valid(ms))
        for (ms in listOf(-1, 1, 2_999, 5_000, 12_000, Int.MAX_VALUE)) assertNull(CrossfadePlan.valid(ms))
        assertNull(CrossfadePlan.valid(null))
    }

    @Test
    fun theFadeShrinksToAThirdOfTheShorterTrack() {
        assertEquals(10_000L, CrossfadePlan.fadeMs(10_000L, 4 * min, 3 * min))
        // 24 s track: 8 s at most.
        assertEquals(8_000L, CrossfadePlan.fadeMs(10_000L, 24_000L, 3 * min))
        // A short next track shrinks it too; an unknown one doesn't.
        assertEquals(5_000L, CrossfadePlan.fadeMs(10_000L, 4 * min, 15_000L))
        assertEquals(10_000L, CrossfadePlan.fadeMs(10_000L, 4 * min, -1L))
        // Below a second: none.
        assertEquals(0L, CrossfadePlan.fadeMs(3_000L, 2_900L, 3 * min))
        assertEquals(1_000L, CrossfadePlan.fadeMs(3_000L, 3_000L, 3 * min))
        // Off, or a track of unknown length: none.
        assertEquals(0L, CrossfadePlan.fadeMs(0L, 4 * min, 3 * min))
        assertEquals(0L, CrossfadePlan.fadeMs(6_000L, -1L, 3 * min))
    }

    @Test
    fun thePrimeComesBeforeTheFadeByThePrerollAndTheLoadTime() {
        // 4 min, 6 s: hand-over at 234 s, preroll 300 ms before it, the tail made 1.5 s before that.
        assertEquals(4 * min - 6_000L - 300L - 1_500L, CrossfadePlan.primeAtMs(6_000L, 4 * min))
        assertNull(CrossfadePlan.primeAtMs(0L, 4 * min))
        assertNull(CrossfadePlan.primeAtMs(6_000L, -1L))
        // The shortest track that fades (3 s, a 1 s fade) still primes after its start.
        assertEquals(200L, CrossfadePlan.primeAtMs(10_000L, 3_000L))
        assertNull(CrossfadePlan.primeAtMs(10_000L, 2_999L))
    }

    @Test
    fun aTrackThatCanFadeFadesAtTheEndMinusTheFade() {
        assertEquals(CrossfadePlan.Decision.Fade(6_000L, 4 * min - 6_000L), CrossfadePlan.decide(facts()))
        // Shrunk to fit a 15 s next track.
        assertEquals(CrossfadePlan.Decision.Fade(5_000L, 4 * min - 5_000L), CrossfadePlan.decide(facts(nextDurationMs = 15_000L, nextBufferedMs = 15_000L)))
    }

    @Test
    fun whenItDoesNotFade() {
        fun why(f: CrossfadePlan.Facts) = (CrossfadePlan.decide(f) as CrossfadePlan.Decision.No).why
        assertEquals(CrossfadePlan.Skip.OFF, why(facts(settingMs = 0L)))
        assertEquals(CrossfadePlan.Skip.NOT_PLAYING, why(facts(playing = false)))
        assertEquals(CrossfadePlan.Skip.REPEAT_ONE, why(facts(repeatOne = true)))
        assertEquals(CrossfadePlan.Skip.LAST, why(facts(hasNext = false)))
        assertEquals(CrossfadePlan.Skip.OUTAGE, why(facts(outage = true)))
        assertEquals(CrossfadePlan.Skip.NOT_OURS, why(facts(ours = false)))
        assertEquals(CrossfadePlan.Skip.TOO_SHORT, why(facts(durationMs = 2_000L, positionMs = 0L)))
        assertEquals(CrossfadePlan.Skip.TOO_SHORT, why(facts(durationMs = -1L)))
        // Seeked to within the last moments: no time to load the tail.
        assertEquals(CrossfadePlan.Skip.TOO_LATE, why(facts(positionMs = 4 * min - 6_000L - 700L)))
        assertTrue(CrossfadePlan.decide(facts(positionMs = 4 * min - 6_000L - 800L)) is CrossfadePlan.Decision.Fade)
        // The next track couldn't start at once: a normal transition, never a stall.
        assertEquals(CrossfadePlan.Skip.NEXT_NOT_READY, why(facts(nextDurationMs = -1L)))
        assertEquals(CrossfadePlan.Skip.NEXT_NOT_READY, why(facts(nextBufferedMs = 8_499L)))
        assertTrue(CrossfadePlan.decide(facts(nextBufferedMs = 8_500L)) is CrossfadePlan.Decision.Fade)
    }

    @Test
    fun aShortNextTrackNeedsOnlyAllOfItBuffered() {
        // 6 s next track: fade 2 s, needs 4.5 s or all of it but the last second (5 s): 4.5 s.
        assertEquals(4_500L, CrossfadePlan.nextNeededMs(2_000L, 6_000L))
        assertEquals(3_000L, CrossfadePlan.nextNeededMs(1_000L, 4_000L))
        assertEquals(8_500L, CrossfadePlan.nextNeededMs(6_000L, 3 * min))
    }

    @Test
    fun theHandOverChecksAgain() {
        assertTrue(CrossfadePlan.canHandOver(facts(positionMs = 4 * min - 6_000L), 6_000L))
        assertFalse(CrossfadePlan.canHandOver(facts(playing = false), 6_000L))
        assertFalse(CrossfadePlan.canHandOver(facts(hasNext = false), 6_000L))
        assertFalse(CrossfadePlan.canHandOver(facts(repeatOne = true), 6_000L))
        assertFalse(CrossfadePlan.canHandOver(facts(outage = true), 6_000L))
        assertFalse(CrossfadePlan.canHandOver(facts(nextBufferedMs = 1_000L), 6_000L))
    }

    @Test
    fun theCurveIsEqualPower() {
        assertEquals(1f, CrossfadePlan.outGain(0f), 0f)
        assertEquals(0f, CrossfadePlan.inGain(0f), 0f)
        assertEquals(0f, CrossfadePlan.outGain(1f), 1e-6f)
        assertEquals(1f, CrossfadePlan.inGain(1f), 0f)
        assertEquals(0.7071f, CrossfadePlan.outGain(0.5f), 1e-4f)
        assertEquals(0.7071f, CrossfadePlan.inGain(0.5f), 1e-4f)
        // Constant power all the way, and each gain moves one way only.
        var lastOut = 1f
        var lastIn = 0f
        for (i in 0..100) {
            val t = i / 100f
            val o = CrossfadePlan.outGain(t)
            val n = CrossfadePlan.inGain(t)
            assertEquals(1f, o * o + n * n, 1e-5f)
            assertTrue(o <= lastOut && n >= lastIn)
            lastOut = o
            lastIn = n
        }
        // Clamped outside 0..1.
        assertEquals(1f, CrossfadePlan.outGain(-1f), 0f)
        assertEquals(1f, CrossfadePlan.inGain(2f), 0f)
    }

    @Test
    fun progressRunsFromZeroToOneOverTheFade() {
        assertEquals(0f, CrossfadePlan.progress(1_000L, 1_000L, 6_000L), 0f)
        assertEquals(0.5f, CrossfadePlan.progress(4_000L, 1_000L, 6_000L), 0f)
        assertEquals(1f, CrossfadePlan.progress(9_000L, 1_000L, 6_000L), 0f)
        assertEquals(0f, CrossfadePlan.progress(500L, 1_000L, 6_000L), 0f)
        assertEquals(1f, CrossfadePlan.progress(0L, 0L, 0L), 0f)
    }

    // ---- Crossfader ----------------------------------------------------------------------

    private class FakeTail(val positionMs: Long, val events: Crossfader.TailEvents) : Crossfader.Tail {
        override var isReady = true
        var playing = false
        var level = 0f
        var released = false
        val volumes = ArrayList<Float>()

        override fun play() {
            check(!released)
            playing = true
        }

        override fun setVolume(v: Float) {
            check(!released)
            level = v
            volumes.add(v)
        }

        override fun release() {
            check(!released) { "released twice" }
            released = true
            playing = false
        }
    }

    /** The main player and its handler, by hand: [play] moves the position and delivers messages and steps. */
    private class FakeHost : Crossfader.Host {
        var f = CrossfadeTest().facts(positionMs = 0L)
        var item: Any? = "a"
        var position = 0L
        var clock = 0L
        var mainLevel = 1f
        val mainVolumes = ArrayList<Float>()
        val messages = ArrayList<Pair<Long, () -> Unit>>()
        val posted = ArrayList<Pair<Long, Runnable>>()
        val tails = ArrayList<FakeTail>()
        var advances = 0
        var onAdvance: () -> Unit = {}
        var makeTail = true

        override fun facts(settingMs: Long) = f.copy(settingMs = settingMs, positionMs = position)

        override fun currentItem(): Any? = item

        override fun positionMs() = position

        override fun durationMs() = f.durationMs

        override fun at(positionMs: Long, action: () -> Unit) {
            messages.add(positionMs to action)
        }

        override fun cancelAll() = messages.clear()

        override fun post(delayMs: Long, r: Runnable) {
            posted.add(clock + delayMs to r)
        }

        override fun remove(r: Runnable) {
            posted.removeAll { it.second === r }
        }

        override fun now() = clock

        override val baseVolume = 1f

        override fun setMainVolume(v: Float) {
            mainLevel = v
            mainVolumes.add(v)
        }

        override fun advance() {
            advances++
            onAdvance()
        }

        override fun newTail(positionMs: Long, events: Crossfader.TailEvents): Crossfader.Tail? {
            if (!makeTail) return null
            return FakeTail(positionMs, events).also { tails.add(it) }
        }

        /** Plays until [to] (or until the item changes): messages as the position passes them, steps as the clock does. */
        fun play(to: Long, step: Long = 10L) {
            val playing = item
            while (position < to && item == playing) {
                val old = position
                position = minOf(to, position + step)
                clock += position - old
                messages.filter { it.first in (old + 1)..position }.forEach { m ->
                    messages.remove(m)
                    m.second()
                }
                posted.filter { it.first <= clock }.forEach { p ->
                    posted.remove(p)
                    p.second.run()
                }
            }
        }

        val tail get() = tails.lastOrNull()
    }

    private val dur = 4 * min
    private val handOverAt = dur - 6_000L

    private fun started(settingMs: Int = 6_000): Pair<FakeHost, Crossfader> {
        val h = FakeHost()
        val c = Crossfader(h, settingMs)
        c.onReady()
        return h to c
    }

    /** Played to the middle of a 6 s fade (the main player now on track b). */
    private fun fading(): Pair<FakeHost, Crossfader> {
        val (h, c) = started()
        h.onAdvance = {
            h.item = "b"
            c.onItemChanged() // our own: ignored
            c.onSeek(nearStart = true)
            c.onBuffering()
            h.position = 0L
        }
        h.play(handOverAt)
        assertEquals(Crossfader.Phase.FADING, c.phase)
        h.play(3_000L)
        return h to c
    }

    /** Nothing of the fade is left: no tail, no step, the main player at full volume. */
    private fun assertStopped(h: FakeHost, c: Crossfader) {
        assertEquals(Crossfader.Phase.NONE, c.phase)
        assertTrue(h.tails.all { it.released })
        assertTrue("no step left", h.posted.isEmpty())
        assertEquals(1f, h.mainLevel, 0f)
    }

    @Test
    fun offSetsNothing() {
        val (h, c) = started(settingMs = 0)
        h.play(dur)
        assertTrue(h.messages.isEmpty())
        assertTrue(h.tails.isEmpty())
        assertEquals(0, h.advances)
        assertEquals(Crossfader.Phase.NONE, c.phase)
    }

    @Test
    fun anUnknownSettingIsOff() {
        val (h, _) = started(settingMs = 5_000)
        assertTrue(h.messages.isEmpty())
    }

    @Test
    fun aFadeFromPrimeToEnd() {
        val (h, c) = started()
        assertEquals(listOf(handOverAt - 300L - 1_500L), h.messages.map { it.first })

        h.play(handOverAt - 1_800L)
        // Primed: a paused tail where the preroll starts.
        assertEquals(Crossfader.Phase.PRIMED, c.phase)
        val tail = h.tail!!
        assertEquals(handOverAt - 300L, tail.positionMs)
        assertFalse(tail.playing)
        assertTrue(h.posted.isEmpty()) // no timer before the fade

        h.play(handOverAt - 300L)
        // Preroll: playing, muted.
        assertEquals(Crossfader.Phase.PREROLL, c.phase)
        assertTrue(tail.playing)
        assertEquals(0f, tail.level, 0f)
        assertEquals(0, h.advances)

        h.onAdvance = { h.item = "b"; h.position = 0L }
        h.play(handOverAt)
        // The hand-over: the tail at full volume, the main player silent and on the next track.
        assertEquals(Crossfader.Phase.FADING, c.phase)
        assertEquals(1, h.advances)
        assertEquals(1f, tail.level, 0f)
        assertEquals(0f, h.mainLevel, 0f)
        assertEquals(1, h.posted.size)

        h.play(3_000L)
        assertEquals(CrossfadePlan.outGain(0.5f), tail.level, 0.02f)
        assertEquals(CrossfadePlan.inGain(0.5f), h.mainLevel, 0.02f)
        // Steps every 50 ms only: about 60 in 3 s.
        assertTrue(tail.volumes.size in 55..65)

        h.play(6_000L)
        // Over: the tail released, no step left, full volume.
        assertStopped(h, c)
        assertEquals(1, h.tails.size)
        // The volume only ever went up on the main player, and down on the tail.
        assertEquals(h.mainVolumes.sorted(), h.mainVolumes)
        assertEquals(tail.volumes.drop(1).sortedDescending(), tail.volumes.drop(1))
    }

    @Test
    fun theNextTrackGetsItsOwnPrimeAtTheHandOver() {
        val (h, _) = fading()
        // Armed for track b (same length in the fake): its prime is the only message left.
        assertEquals(listOf(handOverAt - 1_800L), h.messages.map { it.first })
        h.play(6_000L)
        h.play(handOverAt - 1_800L)
        assertEquals(2, h.tails.size)
    }

    @Test
    fun ourOwnAdvanceIsNotTheUsers() {
        val (h, c) = fading()
        assertEquals(Crossfader.Phase.FADING, c.phase)
        assertFalse(h.tail!!.released)
    }

    @Test
    fun aLateEchoOfOurSeekIsIgnoredButALaterSeekStops() {
        val (h, c) = started()
        h.onAdvance = { h.item = "b"; h.position = 0L }
        h.play(handOverAt)
        h.play(500L)
        c.onSeek(nearStart = true)
        assertEquals(Crossfader.Phase.FADING, c.phase)
        h.play(1_500L)
        c.onSeek(nearStart = true)
        assertStopped(h, c)
    }

    @Test
    fun aPauseDuringTheFadeStopsItAtOnce() {
        val (h, c) = fading()
        c.onHalted()
        assertStopped(h, c)
    }

    @Test
    fun aSeekSkipOrNewItemDuringTheFadeStopsIt() {
        for (event in listOf<(Crossfader, FakeHost) -> Unit>(
            { c, _ -> c.onSeek(nearStart = false) },
            { c, h -> h.item = "c"; c.onItemChanged() },
        )) {
            val (h, c) = fading()
            event(c, h)
            assertStopped(h, c)
        }
    }

    @Test
    fun theSettingChangedDuringTheFadeStopsIt() {
        val (h, c) = fading()
        c.setSetting(10_000)
        assertStopped(h, c)
        // The same setting again changes nothing.
        val (h2, c2) = fading()
        c2.setSetting(6_000)
        assertEquals(Crossfader.Phase.FADING, c2.phase)
        assertFalse(h2.tail!!.released)
    }

    @Test
    fun aTailErrorOrItsEndStopsTheFade() {
        val (h, c) = fading()
        h.tail!!.events.onTailError()
        assertStopped(h, c)
        val (h2, c2) = fading()
        h2.tail!!.events.onTailEnded()
        assertStopped(h2, c2)
    }

    @Test
    fun aReleasedTailsLateEventChangesNothing() {
        val (h, c) = fading()
        val old = h.tail!!
        h.play(6_000L)
        h.play(handOverAt - 1_800L)
        assertEquals(Crossfader.Phase.PRIMED, c.phase)
        old.events.onTailError()
        assertEquals(Crossfader.Phase.PRIMED, c.phase)
        assertFalse(h.tail!!.released)
    }

    @Test
    fun theQueueChangingDuringTheFadeLetsItRun() {
        val (h, c) = fading()
        // Autoplay adds tracks, repeat or shuffle change: the fade no longer depends on them.
        c.onQueueChanged()
        c.onDurationKnown()
        c.onBuffering()
        c.onReady()
        assertEquals(Crossfader.Phase.FADING, c.phase)
        assertFalse(h.tail!!.released)
        h.play(6_000L)
        assertStopped(h, c)
    }

    @Test
    fun beforeTheHandOverAHaltDropsTheTail() {
        val events = listOf<(Crossfader) -> Unit>({ it.onHalted() }, { it.onBuffering() }, { it.release() })
        for ((i, event) in events.withIndex()) {
            for (at in listOf(handOverAt - 1_800L, handOverAt - 300L)) {
                val (h, c) = started()
                h.play(at)
                assertTrue(c.phase == Crossfader.Phase.PRIMED || c.phase == Crossfader.Phase.PREROLL)
                event(c)
                assertTrue("event $i at $at", h.tails.single().released)
                assertStopped(h, c)
                assertTrue(h.mainVolumes.isEmpty()) // never touched
                // The track ends the usual way: no hand-over by a stale message.
                h.play(dur)
                assertEquals("event $i at $at", 0, h.advances)
            }
        }
    }

    @Test
    fun beforeTheHandOverAChangePlansAgain() {
        val events = listOf<(Crossfader, FakeHost) -> Unit>(
            { c, _ -> c.onSeek(nearStart = false) },
            { c, _ -> c.onQueueChanged() },
            { c, h -> h.item = "c"; c.onItemChanged() },
            { c, _ -> c.setSetting(3_000) },
        )
        for ((i, event) in events.withIndex()) {
            for (at in listOf(handOverAt - 1_800L, handOverAt - 300L)) {
                val (h, c) = started()
                h.play(at)
                val first = h.tail!!
                event(c, h)
                assertTrue("event $i at $at", first.released)
                assertTrue(h.mainVolumes.isEmpty())
                // At most one tail, new, for the plan made now.
                assertTrue(h.tails.count { !it.released } <= 1)
                assertTrue(h.tails.filter { !it.released }.all { !it.playing })
            }
        }
    }

    @Test
    fun aQueueChangeBeforeTheHandOverPlansAgain() {
        val (h, c) = started()
        h.play(handOverAt - 1_800L)
        c.onQueueChanged()
        // Still before the hand-over, with time to load: a new tail at once.
        assertEquals(2, h.tails.size)
        assertTrue(h.tails[0].released)
        assertEquals(Crossfader.Phase.PRIMED, c.phase)
    }

    @Test
    fun aTailNotReadyByThePrerollMeansNoFade() {
        val (h, c) = started()
        h.play(handOverAt - 1_800L)
        h.tail!!.isReady = false
        h.play(dur)
        assertEquals(0, h.advances)
        assertStopped(h, c)
    }

    @Test
    fun theNextTrackNotBufferedAtTheHandOverMeansNoFade() {
        val (h, c) = started()
        h.play(handOverAt - 1L)
        h.f = h.f.copy(nextBufferedMs = 0L)
        h.play(handOverAt)
        assertEquals(0, h.advances)
        assertStopped(h, c)
    }

    @Test
    fun noFadeWhenThePlanSaysNo() {
        for (f in listOf(
            CrossfadeTest().facts(repeatOne = true),
            CrossfadeTest().facts(hasNext = false),
            CrossfadeTest().facts(outage = true),
            CrossfadeTest().facts(nextBufferedMs = 0L),
        )) {
            val h = FakeHost()
            h.f = f.copy(positionMs = 0L)
            val c = Crossfader(h, 6_000)
            c.onReady()
            h.play(dur)
            assertTrue(h.tails.isEmpty())
            assertEquals(0, h.advances)
        }
    }

    @Test
    fun noTailNoFade() {
        val (h, c) = started()
        h.makeTail = false
        h.play(dur)
        assertEquals(0, h.advances)
        assertEquals(Crossfader.Phase.NONE, c.phase)
    }

    @Test
    fun aResumeNearTheEndPrimesAtOnceIfThereIsTimeElseNot() {
        val (h, c) = started()
        c.onHalted()
        h.position = handOverAt - 1_000L
        c.onResumed()
        assertEquals(Crossfader.Phase.PRIMED, c.phase)

        val (h2, c2) = started()
        c2.onHalted()
        h2.position = handOverAt - 500L
        c2.onResumed()
        assertEquals(Crossfader.Phase.NONE, c2.phase)
        assertTrue(h2.tails.isEmpty())
    }

    @Test
    fun aPrimeDuringAFadeWaits() {
        // A 4.5 s next track: its prime (at 0) comes while the fade into it runs.
        val (h, c) = started(settingMs = 3_000)
        h.f = h.f.copy(nextDurationMs = 4_500L, nextBufferedMs = 4_500L)
        h.onAdvance = {
            h.item = "b"
            h.position = 0L
            h.f = h.f.copy(durationMs = 4_500L)
        }
        h.play(dur - 1_500L)
        assertEquals(Crossfader.Phase.FADING, c.phase)
        assertEquals(1, h.tails.size)
    }

    @Test
    fun releaseLeavesNothing() {
        val (h, c) = fading()
        c.release()
        assertStopped(h, c)
        assertTrue(h.messages.isEmpty())
        // Nothing fires afterwards.
        h.position = 0L
        h.play(dur)
        assertEquals(1, h.advances)
    }
}
