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
        // 4 min, 6 s: hand-over at 234 s, preroll 2.5 s before it, the tail made 1.5 s before that.
        assertEquals(4 * min - 6_000L - 2_500L - 1_500L, CrossfadePlan.primeAtMs(6_000L, 4 * min))
        assertNull(CrossfadePlan.primeAtMs(0L, 4 * min))
        assertNull(CrossfadePlan.primeAtMs(6_000L, -1L))
        // The shortest track that fades (3 s, a 1 s fade): never before its start.
        assertEquals(0L, CrossfadePlan.primeAtMs(10_000L, 3_000L))
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
        assertEquals(CrossfadePlan.Skip.TOO_LATE, why(facts(positionMs = 4 * min - 6_000L - 2_900L)))
        assertTrue(CrossfadePlan.decide(facts(positionMs = 4 * min - 6_000L - 3_000L)) is CrossfadePlan.Decision.Fade)
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

    // ---- TailAlign ------------------------------------------------------------------------

    /**
     * Samples every 50 ms over a 2.35 s preroll (to the swap) from a tail that starts
     * [latencies] ms late (one per start), with [noise] added to its read position at each
     * step and [early] added while it has run less than 500 ms (the coarse first estimate).
     * Returns the aligner and the seeks.
     */
    private fun align(
        latencies: List<Long>,
        noise: (Int) -> Long = { 0L },
        early: Long = 0L,
        swapAtMs: Long = 2_350L,
    ): Pair<TailAlign, List<Long>> {
        val a = TailAlign()
        val seeks = ArrayList<Long>()
        var anchorPos = 0L
        var anchorAt = 0L
        var starts = 0
        var i = 0
        var now = 50L
        while (now <= swapAtMs) {
            val ran = now - anchorAt - latencies[minOf(starts, latencies.lastIndex)]
            var tail = anchorPos + ran.coerceAtLeast(0L)
            if (ran in 1L..499L) tail += early
            if (ran > 0L) tail += noise(i)
            val s = a.sample(now, now, tail, swapAtMs - now)
            if (s is TailAlign.Step.Seek) {
                seeks.add(s.toMs)
                anchorPos = s.toMs
                anchorAt = now
                starts++
            }
            i++
            now += 50L
        }
        return a to seeks
    }

    @Test
    fun aTailThatStartsInTimeNeedsNoSeek() {
        val (a, seeks) = align(listOf(10L))
        assertTrue(seeks.isEmpty())
        assertEquals(10L, a.driftMs)
        assertTrue(a.handOverOk)
    }

    @Test
    fun aTailThatStartsLateIsSentAheadByItsDelayOnceSettled() {
        // 300 ms (Bluetooth): running at 350, settled at 950, three samples: sent 300 ms ahead at
        // 1050, then lined up well before the swap.
        val (a, seeks) = align(listOf(300L))
        assertEquals(listOf(1_050L + 300L), seeks)
        assertEquals(0L, a.driftMs)
        assertEquals(1, a.seeks)
        assertTrue(a.handOverOk)
    }

    @Test
    fun theCoarseFirstEstimateAndNoisyReadsCauseNoSeek() {
        // 80 ms off for its first half second (and below zero at first), then reads a few ms
        // stale either way with an outlier now and then: one read alone would say 40 ms off and
        // send it away, the median of settled samples says it is lined up.
        val jitter = listOf(0L, 12L, -12L, 7L, 40L, 3L, -9L, 11L)
        // (The swap comes right after such an outlier.)
        val (a, seeks) = align(listOf(0L), noise = { jitter[it % jitter.size] }, early = -80L, swapAtMs = 2_250L)
        assertTrue(seeks.isEmpty())
        assertTrue(a.handOverOk)
    }

    @Test
    fun noMeasureUntilTheTailHasRunSteadilyForAWhile() {
        val a = TailAlign()
        assertEquals(TailAlign.Step.Wait, a.sample(50L, 50L, 0L, 2_000L))
        assertEquals(TailAlign.Step.Wait, a.sample(100L, 100L, 0L, 2_000L)) // not started yet
        var now = 150L
        while (now < 150L + TailAlign.SETTLE_MS + 100L) {
            assertEquals(TailAlign.Step.Wait, a.sample(now, now, now - 100L, 2_000L))
            now += 50L
        }
        assertNull(a.driftMs)
        assertFalse(a.handOverOk)
        // A stall (no progress twice) voids what was gathered: it settles again from scratch.
        val stalledAt = now - 150L
        assertEquals(TailAlign.Step.Wait, a.sample(now, now, stalledAt, 2_000L))
        assertEquals(TailAlign.Step.Wait, a.sample(now + 50L, now + 50L, stalledAt, 2_000L))
        now += 100L
        repeat(5) {
            assertEquals(TailAlign.Step.Wait, a.sample(now, now, now - 100L, 2_000L))
            now += 50L
        }
        assertNull(a.driftMs)
    }

    @Test
    fun neverASeekTooCloseToTheSwapOnlyAJudgement() {
        // Measured only 550 ms before the swap, 100 ms off: no seek (no time to settle and
        // measure again), so no fade.
        val a = TailAlign()
        var now = 0L
        while (now <= 1_000L) {
            val s = a.sample(now, now, now - 100L, 1_300L - now)
            assertFalse(s is TailAlign.Step.Seek)
            now += 50L
        }
        assertEquals(100L, a.driftMs)
        assertEquals(0, a.seeks)
        assertFalse(a.handOverOk)
    }

    @Test
    fun onceLinedUpItOnlyJudges() {
        // Lined up, then the reads wander 40 ms off near the swap: no late seek, and no hand-over.
        val a = TailAlign()
        var now = 0L
        while (now <= 800L) {
            a.sample(now, now, now, 2_000L - now)
            now += 50L
        }
        assertTrue(a.handOverOk)
        while (now <= 1_200L) {
            assertFalse(a.sample(now, now, now - 40L, 2_000L - now) is TailAlign.Step.Seek)
            now += 50L
        }
        assertEquals(0, a.seeks)
        assertEquals(40L, a.driftMs)
        assertFalse(a.handOverOk)
        // Within 30 ms the swap's ramp hides it.
        while (now <= 1_500L) {
            a.sample(now, now, now - 25L, 2_000L - now)
            now += 50L
        }
        assertTrue(a.handOverOk)
    }

    @Test
    fun aTailThatCantBeLinedUpIsNotHandedOver() {
        // A start delay that grows with each start: one seek, then no time for another.
        val (a, seeks) = align(listOf(100L, 200L))
        assertEquals(1, seeks.size)
        assertEquals(100L, a.driftMs)
        assertFalse(a.handOverOk)
    }

    // ---- Crossfader ----------------------------------------------------------------------

    /** A tail whose sound starts [latencies] ms after it is played or seeked (one per start). */
    private class FakeTail(
        val startMs: Long,
        val events: Crossfader.TailEvents,
        private val clock: () -> Long,
        private val latencies: List<Long>,
    ) : Crossfader.Tail {
        override var isReady = true
        var playing = false
        var level = 0f
        var released = false
        val volumes = ArrayList<Float>()
        val seeks = ArrayList<Long>()
        private var anchorPos = startMs
        private var anchorAt = 0L
        private var starts = 0

        override val positionMs: Long
            get() = if (!playing) anchorPos else anchorPos + (clock() - anchorAt - latency()).coerceAtLeast(0L)

        private fun latency() = latencies[minOf(starts - 1, latencies.lastIndex).coerceAtLeast(0)]

        override fun play() {
            check(!released)
            playing = true
            anchorAt = clock()
            starts++
        }

        override fun seekTo(positionMs: Long) {
            check(!released)
            seeks.add(positionMs)
            anchorPos = positionMs
            anchorAt = clock()
            starts++
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
        var next: Any? = "b"
        var position = 0L
        var clock = 0L
        var mainLevel = 1f
        val mainVolumes = ArrayList<Float>()
        val messages = ArrayList<Pair<Long, () -> Unit>>()
        val posted = ArrayList<Pair<Long, Runnable>>()
        val tails = ArrayList<FakeTail>()
        var advances = 0
        var onAdvance: () -> Unit = { item = next; next = "n$advances"; position = 0L }
        var makeTail = true
        var latencies = listOf(0L)

        /** The main player's volume reads back what was set last, as ExoPlayer's does. */
        override val mainVolume get() = mainLevel

        override fun facts(settingMs: Long) = f.copy(settingMs = settingMs, positionMs = position)

        override fun currentItem(): Any? = item

        override fun nextItem(): Any? = next

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

        override fun setMainVolume(v: Float) {
            mainLevel = v
            mainVolumes.add(v)
        }

        override fun advance() {
            advances++
            onAdvance()
        }

        val judgements = ArrayList<Triple<Long?, Int, Boolean>>()

        override fun judged(driftMs: Long?, seeks: Int, handedOver: Boolean) {
            judgements.add(Triple(driftMs, seeks, handedOver))
        }

        override fun newTail(positionMs: Long, events: Crossfader.TailEvents): Crossfader.Tail? {
            if (!makeTail) return null
            return FakeTail(positionMs, events, { clock }, latencies).also { tails.add(it) }
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
    private val prerollAt = handOverAt - CrossfadePlan.PREROLL_MS
    private val primeAt = prerollAt - CrossfadePlan.PREP_MS
    private val swapAt = handOverAt - CrossfadePlan.SWAP_MS

    private fun started(settingMs: Int = 6_000, latencies: List<Long> = listOf(0L)): Pair<FakeHost, Crossfader> {
        val h = FakeHost()
        h.latencies = latencies
        val c = Crossfader(h, settingMs)
        c.onReady()
        return h to c
    }

    /** Played to the middle of a 6 s fade (the main player now on track b), the main player's own volume [own]. */
    private fun fading(own: Float = 1f): Pair<FakeHost, Crossfader> {
        val (h, c) = started()
        h.mainLevel = own
        h.onAdvance = {
            h.item = "b"
            h.next = "c"
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

    /** Nothing of the fade is left: no tail, no step, the main player at its own volume ([own]). */
    private fun assertStopped(h: FakeHost, c: Crossfader, own: Float = 1f) {
        assertEquals(Crossfader.Phase.NONE, c.phase)
        assertTrue(h.tails.all { it.released })
        assertTrue("no step left", h.posted.isEmpty())
        assertEquals(own, h.mainLevel, 0f)
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
        assertEquals(listOf(primeAt), h.messages.map { it.first })

        h.play(primeAt)
        // Primed: a paused tail where the preroll starts.
        assertEquals(Crossfader.Phase.PRIMED, c.phase)
        val tail = h.tail!!
        assertEquals(prerollAt, tail.startMs)
        assertFalse(tail.playing)
        assertTrue(h.posted.isEmpty()) // no timer before the preroll

        h.play(prerollAt)
        // Preroll: playing, muted, lined up (in time already: no seek).
        assertEquals(Crossfader.Phase.PREROLL, c.phase)
        assertTrue(tail.playing)
        assertEquals(0f, tail.level, 0f)
        h.play(swapAt - 10L)
        assertTrue(tail.seeks.isEmpty())
        assertTrue(h.mainVolumes.isEmpty())
        assertEquals(0, h.advances)

        // The swap: the outgoing track moves from the main player to the tail in three steps.
        h.play(swapAt + 100L)
        assertEquals(Crossfader.Phase.SWAP, c.phase)
        assertEquals(2f / 3f, tail.level, 0.01f)
        assertEquals(1f / 3f, h.mainLevel, 0.01f)
        assertEquals(0, h.advances)

        h.play(handOverAt)
        // The hand-over: the tail at full volume, the main player silent and on the next track.
        assertEquals(Crossfader.Phase.FADING, c.phase)
        assertEquals(1, h.advances)
        assertEquals(1f, tail.level, 0f)
        assertEquals(0f, h.mainLevel, 0f)
        assertEquals(1, h.posted.size)
        val atHandOver = tail.volumes.size
        val mainAtHandOver = h.mainVolumes.size

        h.play(3_000L)
        assertEquals(CrossfadePlan.outGain(0.5f), tail.level, 0.02f)
        assertEquals(CrossfadePlan.inGain(0.5f), h.mainLevel, 0.02f)
        // Steps every 50 ms only: 60 in 3 s.
        assertTrue(tail.volumes.size - atHandOver in 58..61)

        h.play(6_000L)
        // Over: the tail released, no step left, full volume.
        assertStopped(h, c)
        assertEquals(1, h.tails.size)
        // During the fade the volume only went up on the main player, and down on the tail.
        val fadeIn = h.mainVolumes.drop(mainAtHandOver - 1)
        assertEquals(fadeIn.sorted(), fadeIn)
        val fadeOut = tail.volumes.drop(atHandOver - 1)
        assertEquals(fadeOut.sortedDescending(), fadeOut)
    }

    @Test
    fun aLateTailIsSentAheadAndTheFadeGoesOn() {
        // A Bluetooth-like start delay of 300 ms: settled and measured, sent 300 ms ahead once,
        // then settled and lined up before the swap.
        val (h, c) = started(latencies = listOf(300L))
        h.play(swapAt - 10L)
        val tail = h.tail!!
        assertEquals(1, tail.seeks.size)
        assertEquals(prerollAt + 1_050L + 300L, tail.seeks.single())
        assertEquals(0L, h.position - tail.positionMs)
        h.play(handOverAt)
        assertEquals(1, h.advances)
        assertEquals(Crossfader.Phase.FADING, c.phase)
        // Told (debug builds log it): lined up after one seek, handed over.
        assertEquals(listOf(Triple<Long?, Int, Boolean>(0L, 1, true)), h.judgements)
    }

    @Test
    fun aTailThatCantBeLinedUpMeansNoFade() {
        // The delay grows with each start: 100 ms off at the swap, with no time for a second seek.
        val (h, c) = started(latencies = listOf(100L, 200L))
        h.play(dur)
        assertEquals(0, h.advances)
        assertTrue(h.mainVolumes.isEmpty()) // the outgoing track never left the main player
        assertStopped(h, c)
        assertEquals(1, h.tails.single().seeks.size)
        assertEquals(listOf(Triple<Long?, Int, Boolean>(100L, 1, false)), h.judgements)
    }

    @Test
    fun aTailTooSlowToMeasureByTheSwapMeansNoFade() {
        val (h, c) = started(latencies = listOf(1_800L))
        h.play(dur)
        assertEquals(0, h.advances)
        assertStopped(h, c)
        assertEquals(listOf(Triple<Long?, Int, Boolean>(null, 0, false)), h.judgements)
    }

    @Test
    fun theFadeFollowsTheMainPlayersOwnVolume() {
        // Read at the swap, not from the volume the fade itself set (that would sink to silence).
        val (h, c) = fading(own = 0.5f)
        h.play(3_100L)
        val t = CrossfadePlan.progress(h.clock, h.clock - 3_100L, 6_000L)
        assertEquals(0.5f * CrossfadePlan.inGain(t), h.mainLevel, 0.02f)
        assertEquals(0.5f * CrossfadePlan.outGain(t), h.tail!!.level, 0.02f)
        c.onHalted()
        assertStopped(h, c, own = 0.5f)
    }

    @Test
    fun theIncomingTrackFadesInFromSilenceToItsOwnVolume() {
        val (h, c) = started()
        h.play(handOverAt)
        val fromHandOver = h.mainVolumes.size - 1
        h.play(6_000L)
        assertStopped(h, c)
        // On the main player's volume, every step: silent at the hand-over, then up, never down, to whole.
        val fadeIn = h.mainVolumes.drop(fromHandOver)
        assertEquals(0f, fadeIn.first(), 0f)
        assertEquals(1f, fadeIn.last(), 0f)
        assertEquals(fadeIn.sorted(), fadeIn)
        assertTrue(fadeIn.size in 118..122)
        assertEquals(CrossfadePlan.inGain(0.5f), fadeIn[fadeIn.size / 2], 0.03f)
    }

    @Test
    fun theNextTrackGetsItsOwnPrimeAtTheHandOver() {
        val (h, _) = fading()
        // Armed for track b (same length in the fake): its prime is the only message left.
        assertEquals(listOf(primeAt), h.messages.map { it.first })
        h.play(6_000L)
        h.play(primeAt)
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
            { c, h -> h.item = "z"; c.onItemChanged() },
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
    fun aTailErrorOrEndDuringTheFadeLetsTheFadeInFinish() {
        for (gone in listOf<(Crossfader.TailEvents) -> Unit>({ it.onTailError() }, { it.onTailEnded() })) {
            val (h, c) = fading()
            val before = h.mainLevel
            gone(h.tail!!.events)
            assertTrue(h.tail!!.released)
            assertEquals(Crossfader.Phase.FADING, c.phase)
            // No jump: the incoming track keeps rising along the curve.
            assertEquals(before, h.mainLevel, 0f)
            h.play(3_050L)
            assertTrue(h.mainLevel in before..0.99f)
            h.play(6_000L)
            assertStopped(h, c)
        }
    }

    @Test
    fun aTailErrorDuringTheSwapGivesTheTrackBackToTheMainPlayer() {
        val (h, c) = started()
        h.play(swapAt + 60L)
        assertEquals(Crossfader.Phase.SWAP, c.phase)
        assertTrue(h.mainLevel < 1f)
        h.tail!!.events.onTailError()
        assertStopped(h, c)
        h.play(dur)
        assertEquals(0, h.advances)
    }

    @Test
    fun aReleasedTailsLateEventChangesNothing() {
        val (h, c) = fading()
        val old = h.tail!!
        h.play(6_000L)
        h.play(primeAt)
        assertEquals(Crossfader.Phase.PRIMED, c.phase)
        old.events.onTailError()
        assertEquals(Crossfader.Phase.PRIMED, c.phase)
        assertFalse(h.tail!!.released)
    }

    @Test
    fun theQueueChangingDuringTheFadeLetsItRun() {
        val (h, c) = fading()
        // Autoplay adds tracks, repeat or shuffle change: the fade no longer depends on them.
        h.next = "y"
        c.onQueueChanged()
        c.onOrderChanged()
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
            for (at in listOf(primeAt, prerollAt, swapAt + 60L)) {
                val (h, c) = started()
                h.play(at)
                assertTrue(c.phase in setOf(Crossfader.Phase.PRIMED, Crossfader.Phase.PREROLL, Crossfader.Phase.SWAP))
                event(c)
                assertTrue("event $i at $at", h.tails.single().released)
                assertStopped(h, c)
                if (at < swapAt) assertTrue(h.mainVolumes.isEmpty()) // never touched
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
            { c, h -> h.next = "z"; c.onQueueChanged() },
            { c, _ -> c.onOrderChanged() },
            { c, h -> h.item = "z"; c.onItemChanged() },
            { c, _ -> c.setSetting(3_000) },
        )
        for ((i, event) in events.withIndex()) {
            for (at in listOf(primeAt, prerollAt)) {
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
    fun aQueueEditThatKeepsTheNextTrackKeepsTheTail() {
        for (at in listOf(primeAt, prerollAt + 200L)) {
            val (h, c) = started()
            h.play(at)
            val phase = c.phase
            // An autoplay top-up, or the shuffle order put back: the same next track.
            c.onQueueChanged()
            assertEquals(1, h.tails.size)
            assertFalse(h.tail!!.released)
            assertEquals(phase, c.phase)
            h.play(handOverAt)
            assertEquals(1, h.advances)
        }
    }

    @Test
    fun aNewNextTrackBeforeTheHandOverPlansAgain() {
        val (h, c) = started()
        h.play(primeAt)
        h.next = "z"
        c.onQueueChanged()
        // Still before the hand-over, with time to load: a new tail at once.
        assertEquals(2, h.tails.size)
        assertTrue(h.tails[0].released)
        assertEquals(Crossfader.Phase.PRIMED, c.phase)
    }

    @Test
    fun aTailNotReadyByThePrerollMeansNoFade() {
        val (h, c) = started()
        h.play(primeAt)
        h.tail!!.isReady = false
        h.play(dur)
        assertEquals(0, h.advances)
        assertStopped(h, c)
    }

    @Test
    fun theNextTrackNotBufferedAtTheSwapMeansNoFade() {
        val (h, c) = started()
        h.play(swapAt - 10L)
        h.f = h.f.copy(nextBufferedMs = 0L)
        h.play(swapAt)
        assertEquals(0, h.advances)
        assertStopped(h, c)
        assertTrue(h.mainVolumes.isEmpty())
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
        h.position = handOverAt - 3_000L
        c.onResumed()
        assertEquals(Crossfader.Phase.PRIMED, c.phase)

        val (h2, c2) = started()
        c2.onHalted()
        h2.position = handOverAt - 2_900L
        c2.onResumed()
        assertEquals(Crossfader.Phase.NONE, c2.phase)
        assertTrue(h2.tails.isEmpty())
    }

    @Test
    fun aPrimeThatFallsDuringAFadeComesOnceTheFadeIsOver() {
        // A 9.3 s next track: the fade into it is 3 s, and its own prime (2.3 s in) comes
        // while that fade still runs.
        val (h, c) = started(settingMs = 3_000)
        h.f = h.f.copy(nextDurationMs = 9_300L, nextBufferedMs = 9_300L)
        h.onAdvance = {
            h.item = "t${h.advances}"
            h.next = "n${h.advances}"
            h.position = 0L
            h.f = h.f.copy(durationMs = 9_300L)
        }
        h.play(dur - 3_000L)
        assertEquals(Crossfader.Phase.FADING, c.phase)
        assertEquals(1, h.tails.size)
        h.play(2_900L)
        assertEquals(1, h.tails.size) // not during the fade
        // Once that fade is over, the short track gets its own tail, and fades into the next.
        h.play(3_100L)
        assertEquals(2, h.tails.size)
        assertEquals(Crossfader.Phase.PRIMED, c.phase)
        h.play(6_300L)
        assertEquals(2, h.advances)
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
