package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.playback.CrossfadePlan.Skip
import io.github.iamandelib.cyberjuke.playback.CrossfadePlan.Trigger
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
        gapless: Boolean = true,
        sameAlbum: Boolean = false,
        fading: Boolean = false,
        nextReady: Boolean = true,
    ) = CrossfadePlan.Facts(settingMs, playing, repeatOne, hasNext, outage, gapless, sameAlbum, fading, nextReady)

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
    fun theFadeStartsItsLengthBeforeTheEnd() {
        assertEquals(Trigger.At(4 * min - 6_000L, 6_000L), CrossfadePlan.trigger(6_000L, 4 * min, 3 * min, 0L))
        // Shrunk to fit a 15 s next track: later, and shorter.
        assertEquals(Trigger.At(4 * min - 5_000L, 5_000L), CrossfadePlan.trigger(10_000L, 4 * min, 15_000L, 0L))
        // A moment before the fade is still in time; at or past it, too late (a seek, a resume near the end).
        assertEquals(Trigger.At(4 * min - 6_000L, 6_000L), CrossfadePlan.trigger(6_000L, 4 * min, 3 * min, 4 * min - 6_001L))
        assertEquals(Trigger.No(Skip.TOO_LATE), CrossfadePlan.trigger(6_000L, 4 * min, 3 * min, 4 * min - 6_000L))
        assertEquals(Trigger.No(Skip.TOO_LATE), CrossfadePlan.trigger(6_000L, 4 * min, 3 * min, 4 * min))
        assertEquals(Trigger.No(Skip.OFF), CrossfadePlan.trigger(0L, 4 * min, 3 * min, 0L))
        assertEquals(Trigger.No(Skip.UNKNOWN_LENGTH), CrossfadePlan.trigger(6_000L, -1L, 3 * min, 0L))
        assertEquals(Trigger.No(Skip.TOO_SHORT), CrossfadePlan.trigger(6_000L, 2_000L, 3 * min, 0L))
        assertEquals(Trigger.No(Skip.TOO_SHORT), CrossfadePlan.trigger(6_000L, 4 * min, 2_000L, 0L))
    }

    @Test
    fun theNextTrackNeedNotBeBufferedOnlyPrepared() {
        // The fade is set before the next track's length is known (it shrinks the fade once it is),
        // and waits for the incoming track when it needs a moment to buffer.
        assertEquals(Trigger.At(4 * min - 6_000L, 6_000L), CrossfadePlan.trigger(6_000L, 4 * min, -1L, 0L))
        assertNull(CrossfadePlan.decide(facts()))
        // When it comes due, the next track must be prepared: one that can't play never is, and
        // fading into it would cut this one's end short when it fails.
        assertEquals(Skip.NEXT_NOT_READY, CrossfadePlan.decide(facts(nextReady = false)))
        // Repeat one goes into its own start, which is.
        assertNull(CrossfadePlan.decide(facts(repeatOne = true, hasNext = false)))
    }

    @Test
    fun whenItDoesNotFade() {
        assertNull(CrossfadePlan.decide(facts()))
        assertEquals(Skip.OFF, CrossfadePlan.decide(facts(settingMs = 0L)))
        assertEquals(Skip.NOT_PLAYING, CrossfadePlan.decide(facts(playing = false)))
        assertEquals(Skip.LAST, CrossfadePlan.decide(facts(hasNext = false)))
        assertEquals(Skip.OUTAGE, CrossfadePlan.decide(facts(outage = true)))
        // Two tracks of one album with Gapless on go straight into each other (Metrolist's rule).
        assertEquals(Skip.SAME_ALBUM, CrossfadePlan.decide(facts(sameAlbum = true)))
        assertNull(CrossfadePlan.decide(facts(sameAlbum = true, gapless = false)))
        assertEquals(Skip.FADING, CrossfadePlan.decide(facts(fading = true)))
        // Off comes first: nothing else is looked at.
        assertEquals(Skip.OFF, CrossfadePlan.decide(facts(settingMs = 0L, playing = false, hasNext = false)))
    }

    @Test
    fun repeatOneFadesIntoItsOwnStart() {
        assertNull(CrossfadePlan.decide(facts(repeatOne = true, hasNext = false)))
        assertNull(CrossfadePlan.decide(facts(repeatOne = true)))
    }

    @Test
    fun theCurveRisesFastAndFallsFast() {
        assertEquals(0f, CrossfadePlan.fadeIn(0f), 0f)
        assertEquals(1f, CrossfadePlan.fadeIn(1f), 0f)
        assertEquals(1f, CrossfadePlan.fadeOut(0f), 0f)
        assertEquals(0f, CrossfadePlan.fadeOut(1f), 0f)
        assertEquals(0.75f, CrossfadePlan.fadeIn(0.5f), 1e-6f)
        assertEquals(0.25f, CrossfadePlan.fadeOut(0.5f), 1e-6f)
        // Each moves one way only; clamped outside 0..1.
        var lastIn = 0f
        var lastOut = 1f
        for (i in 0..100) {
            val p = i / 100f
            assertTrue(CrossfadePlan.fadeIn(p) >= lastIn && CrossfadePlan.fadeOut(p) <= lastOut)
            lastIn = CrossfadePlan.fadeIn(p)
            lastOut = CrossfadePlan.fadeOut(p)
        }
        assertEquals(0f, CrossfadePlan.fadeIn(-1f), 0f)
        assertEquals(0f, CrossfadePlan.fadeOut(2f), 0f)
    }

    @Test
    fun twentyStepsOverTheFade() {
        assertEquals(20, CrossfadePlan.STEPS)
        assertEquals(150L, CrossfadePlan.stepMs(3_000L))
        assertEquals(300L, CrossfadePlan.stepMs(6_000L))
        assertEquals(500L, CrossfadePlan.stepMs(10_000L))
    }

    // ---- Crossfader ----------------------------------------------------------------------

    /**
     * The service's players and handler, by hand. [run] lets time pass: each player's position
     * moves while it plays (the main one at [speed]), the main player's messages run as it passes
     * them, it stops at its track's end when a fade asked it to (and the crossfader hears of it),
     * and posted steps run as they come due.
     */
    private class FakeHost : Crossfader.Host {
        var f = CrossfadeTest().facts()
        var fader: Crossfader? = null

        // The main player: the session's.
        var item: Any? = "a"
        var duration = 4 * 60_000L
        var nextDuration = 3 * 60_000L
        var position = 0L
        var speed = 1.0
        override var mainPlaying = true
        var mainLevel = 1f
        val mainVolumes = ArrayList<Float>()

        /** Asked by a fade's start: it stops at its track's end. */
        var pauseAtEnd = false

        // The incoming player, from a fade's start to the hand-over.
        var hasIncoming = false
        var incomingLevel = 0f
        var incomingOn = false
        override var incomingPlaying = false
        var incomingPosition = 0L
        val incomingVolumes = ArrayList<Float>()

        /** It still plays the main one's next track. */
        var incomingNext = true

        var clock = 0L
        val messages = ArrayList<Pair<Long, () -> Unit>>()
        val posted = ArrayList<Pair<Long, Runnable>>()
        var starts = 0
        var startWorks = true
        var onStart: () -> Unit = {}
        var handOvers = 0
        var onHandOver: () -> Unit = {}

        /** How many main volumes were set before the hand-over (the old player's fade-out). */
        var outCount = -1
        var drops = 0
        val skips = ArrayList<Skip>()
        val started = ArrayList<Long>()

        override val mainVolume get() = mainLevel

        override fun facts(settingMs: Long) = f.copy(settingMs = settingMs)

        override fun durationMs() = duration

        override fun nextDurationMs() = nextDuration

        override fun positionMs() = position

        override fun currentItem(): Any? = item

        override fun at(positionMs: Long, action: () -> Unit) {
            messages.add(positionMs to action)
        }

        override fun cancelAll() = messages.clear()

        /** As the service: the next track on a second player, silent and not playing yet; the main one stops at its end. */
        override fun startIncoming(): Boolean {
            if (!startWorks) return false
            check(!hasIncoming) { "a second incoming player" }
            starts++
            hasIncoming = true
            incomingLevel = 0f
            incomingOn = true
            incomingPlaying = false
            incomingPosition = 0L
            pauseAtEnd = true
            onStart()
            return true
        }

        override fun incomingIsNext() = incomingNext

        /** As the service: the incoming player becomes the main one (the session's), where it is. */
        override fun handOver() {
            check(hasIncoming) { "no incoming player" }
            handOvers++
            outCount = mainVolumes.size
            hasIncoming = false
            pauseAtEnd = false
            item = "n$starts"
            duration = nextDuration
            position = incomingPosition
            mainLevel = incomingLevel
            mainPlaying = incomingPlaying
            incomingPlaying = false
            onHandOver()
        }

        override fun dropIncoming() {
            check(hasIncoming) { "dropped twice" }
            drops++
            hasIncoming = false
            incomingOn = false
            incomingPlaying = false
            pauseAtEnd = false
        }

        override fun setMainVolume(v: Float) {
            mainLevel = v
            mainVolumes.add(v)
        }

        override fun setIncomingVolume(v: Float) {
            check(hasIncoming) { "no incoming player" }
            incomingLevel = v
            incomingVolumes.add(v)
        }

        override fun setIncomingPlayWhenReady(playing: Boolean) {
            check(hasIncoming) { "no incoming player" }
            incomingOn = playing
        }

        override fun post(delayMs: Long, r: Runnable) {
            posted.add(clock + delayMs to r)
        }

        override fun remove(r: Runnable) {
            posted.removeAll { it.second === r }
        }

        override fun skipped(why: Skip) {
            skips.add(why)
        }

        override fun started(fadeMs: Long) {
            started.add(fadeMs)
        }

        /** The fade-in's volumes: the incoming player's, then the main one's after the hand-over. */
        val ins: List<Float> get() = incomingVolumes + mainVolumes.drop(maxOf(outCount, 0))

        fun run(ms: Long, tick: Long = 10L) {
            var left = ms
            while (left > 0L) {
                val d = minOf(tick, left)
                left -= d
                val from = position
                clock += d
                if (mainPlaying) position = minOf(position + (d * speed).toLong(), duration)
                if (hasIncoming && incomingPlaying) incomingPosition += d
                for (m in messages.filter { it.first in (from + 1)..position }) if (messages.remove(m)) m.second()
                if (pauseAtEnd && mainPlaying && position >= duration) {
                    mainPlaying = false
                    pauseAtEnd = false
                    fader?.onMainEnded()
                }
                for (p in posted.filter { it.first <= clock }.sortedBy { it.first }) if (posted.remove(p)) p.second.run()
            }
        }

        /** Plays the main player to [to] (its position), whatever time that takes. */
        fun playTo(to: Long) {
            mainPlaying = true
            run(((to - position) / speed).toLong())
        }
    }

    private val dur = 4 * min
    private val fadeAt = dur - 6_000L

    private fun armed(settingMs: Int = 6_000, host: FakeHost = FakeHost()): Pair<FakeHost, Crossfader> {
        val c = Crossfader(host, settingMs)
        host.fader = c
        c.arm()
        return host to c
    }

    /** At the fade's start: the incoming player buffering its first moments, nothing ramped yet. */
    private fun crossing(own: Float = 1f): Pair<FakeHost, Crossfader> {
        val (h, c) = armed()
        h.mainLevel = own
        h.playTo(fadeAt)
        assertEquals(Crossfader.Phase.CROSSING, c.phase)
        return h to c
    }

    /** In the middle of a 6 s fade: the incoming player playing, ten of the twenty steps done, the old track 3 s from its end. */
    private fun fading(own: Float = 1f): Pair<FakeHost, Crossfader> {
        val (h, c) = crossing(own)
        h.incomingPlaying = true
        c.onPlaying()
        h.run(10 * 300L - 10L)
        assertEquals(Crossfader.Phase.CROSSING, c.phase)
        assertEquals(10, h.incomingVolumes.size)
        return h to c
    }

    /** The incoming track started a second late: its ramp ends a second after the old track, which hands over at its end. */
    private fun handedOverLate(): Pair<FakeHost, Crossfader> {
        val (h, c) = crossing()
        h.run(1_000L)
        h.incomingPlaying = true
        c.onPlaying()
        // Nothing set while crossing (that track's fade is under way), whatever changes.
        c.arm()
        c.onPlayWanted(true)
        assertTrue(h.messages.isEmpty())
        h.run(5_050L)
        assertEquals(Crossfader.Phase.RISING, c.phase)
        assertEquals("n1", h.item)
        return h to c
    }

    /** Stopped before the hand-over: the incoming player dropped once, the old one at [own], no step left. */
    private fun assertDropped(h: FakeHost, c: Crossfader, own: Float = 1f) {
        assertEquals(Crossfader.Phase.NONE, c.phase)
        assertFalse(h.hasIncoming)
        assertEquals(1, h.drops)
        assertEquals(0, h.handOvers)
        assertFalse("the old one plays on past its end", h.pauseAtEnd)
        assertTrue("no step left", h.posted.isEmpty())
        assertEquals(own, h.mainLevel, 0f)
        assertEquals("a", h.item)
    }

    /** Over: handed over once, nothing dropped, no step left, the new track at [own]. */
    private fun assertOver(h: FakeHost, c: Crossfader, own: Float = 1f) {
        assertEquals(Crossfader.Phase.NONE, c.phase)
        assertFalse(h.hasIncoming)
        assertEquals(1, h.handOvers)
        assertEquals(0, h.drops)
        assertTrue("no step left", h.posted.isEmpty())
        assertEquals(own, h.mainLevel, 0f)
        assertEquals("n1", h.item)
    }

    @Test
    fun offSetsNothing() {
        val (h, c) = armed(settingMs = 0)
        h.playTo(dur)
        assertTrue(h.messages.isEmpty())
        assertEquals(0, h.starts)
        assertEquals(Crossfader.Phase.NONE, c.phase)
        // Off is the default: never logged.
        assertTrue(h.skips.isEmpty())
    }

    @Test
    fun anUnknownSettingIsOff() {
        val (h, _) = armed(settingMs = 5_000)
        assertTrue(h.messages.isEmpty())
    }

    @Test
    fun aFadeFromItsStartToItsEnd() {
        val (h, c) = armed()
        // One message, a fade before the end; no timer.
        assertEquals(listOf(fadeAt), h.messages.map { it.first })
        assertTrue(h.posted.isEmpty())

        h.playTo(fadeAt)
        // The next track on a second player, silent; the old one at its own volume, stopping at its end.
        assertEquals(Crossfader.Phase.CROSSING, c.phase)
        assertEquals(1, h.starts)
        assertEquals(listOf(6_000L), h.started)
        assertEquals(0f, h.incomingLevel, 0f)
        assertEquals(1f, h.mainLevel, 0f)
        assertTrue(h.pauseAtEnd)
        // The new track buffers its first moments: the ramp waits for it.
        h.run(500L)
        assertTrue(h.incomingVolumes.isEmpty())
        assertTrue(h.mainVolumes.isEmpty())

        h.incomingPlaying = true
        c.onPlaying()
        // The session stays with the old track through the fade...
        h.run(5_400L)
        assertEquals(Crossfader.Phase.CROSSING, c.phase)
        assertEquals("a", h.item)
        assertEquals(0, h.handOvers)
        // ...and moves to the new one when the old one ends, a few seconds into it.
        h.run(200L)
        assertEquals(Crossfader.Phase.RISING, c.phase)
        assertEquals(1, h.handOvers)
        assertEquals("n1", h.item)
        assertTrue(h.position in 5_400L..5_700L)
        // The rest of the ramp on the new one alone.
        h.run(1_000L)
        assertOver(h, c)
        // Twenty steps of 300 ms along the curve, then full volume.
        val ins = h.ins
        assertEquals(21, ins.size)
        for (i in 0 until 20) assertEquals(CrossfadePlan.fadeIn(i / 20f), ins[i], 1e-6f)
        assertEquals(1f, ins.last(), 0f)
        // The old one fell along its curve until it ended.
        assertEquals(19, h.outCount)
        for (i in 0 until 19) assertEquals(CrossfadePlan.fadeOut(i / 20f), h.mainVolumes[i], 1e-6f)
        assertTrue(h.skips.isEmpty())
    }

    @Test
    fun theRampTakesTheFadesLength() {
        val (h, c) = crossing()
        h.incomingPlaying = true
        c.onPlaying()
        val from = h.clock
        while (c.phase != Crossfader.Phase.NONE) h.run(10L)
        assertTrue(h.clock - from in 6_000L..6_010L)
        assertOver(h, c)
    }

    @Test
    fun theFadeFollowsTheOldPlayersOwnVolume() {
        val (h, c) = fading(own = 0.5f)
        assertEquals(0.5f * CrossfadePlan.fadeIn(9 / 20f), h.incomingLevel, 1e-6f)
        assertEquals(0.5f * CrossfadePlan.fadeOut(9 / 20f), h.mainLevel, 1e-6f)
        h.run(4_000L)
        assertOver(h, c, own = 0.5f)
    }

    @Test
    fun theRampEndingBeforeTheOldTrackHandsOverAtOnce() {
        // A slower speed: the old track's end comes after the ramp's.
        val h = FakeHost()
        h.speed = 0.5
        val (_, c) = armed(host = h)
        h.playTo(fadeAt)
        h.incomingPlaying = true
        c.onPlaying()
        h.run(6_000L)
        assertOver(h, c)
        assertTrue(h.clock < fadeAt / 0.5 + 12_000L)
    }

    @Test
    fun theNewTrackIsArmedAtTheHandOverNotBefore() {
        val (h, c) = handedOverLate()
        // The fake knows the new track's length (3 min).
        assertEquals(listOf(3 * min - 6_000L), h.messages.map { it.first })
        h.run(1_000L)
        assertOver(h, c)
    }

    @Test
    fun theNewTrackFadesIntoTheOneAfterIt() {
        val (h, c) = fading()
        h.run(4_000L)
        assertEquals(Crossfader.Phase.NONE, c.phase)
        h.playTo(3 * min - 6_000L)
        assertEquals(2, h.starts)
        assertEquals(Crossfader.Phase.CROSSING, c.phase)
    }

    @Test
    fun aFailedStartSaysSoAndTheTrackEndsTheUsualWay() {
        val h = FakeHost()
        h.startWorks = false
        val (_, c) = armed(host = h)
        h.playTo(fadeAt)
        assertEquals(Crossfader.Phase.NONE, c.phase)
        assertEquals(listOf(Skip.NO_PLAYER), h.skips)
        assertTrue(h.started.isEmpty())
        assertFalse(h.pauseAtEnd)
        h.playTo(dur)
        assertEquals(0, h.handOvers)
        assertTrue(h.mainVolumes.isEmpty())
    }

    @Test
    fun aPauseOrACallMidFadeHoldsBothPlayersAndTheRamp() {
        val (h, c) = fading()
        val steps = h.incomingVolumes.size
        // Paused (or held back by a call) on the main player: the incoming one stops too, no step is taken.
        c.onPlayWanted(false)
        assertFalse(h.incomingOn)
        h.mainPlaying = false
        h.incomingPlaying = false
        h.run(5_000L)
        assertEquals(steps, h.incomingVolumes.size)
        assertEquals(Crossfader.Phase.CROSSING, c.phase)
        assertEquals("a", h.item)
        // Playing again: both go on, the ramp where it was.
        c.onPlayWanted(true)
        assertTrue(h.incomingOn)
        h.mainPlaying = true
        h.incomingPlaying = true
        c.onPlaying()
        assertEquals(steps + 1, h.incomingVolumes.size)
        h.run(4_000L)
        assertOver(h, c)
    }

    @Test
    fun theIncomingTrackBufferingHoldsTheRampAndTheOldOneStillHandsOverAtItsEnd() {
        val (h, c) = fading()
        val steps = h.incomingVolumes.size
        // Buffering: play is still wanted, the old track plays on to its end.
        h.incomingPlaying = false
        h.run(3_500L)
        assertEquals(steps, h.incomingVolumes.size)
        // Handed over to the buffering track; the ramp still waits.
        assertEquals(Crossfader.Phase.RISING, c.phase)
        assertEquals("n1", h.item)
        assertTrue(h.posted.isEmpty())
        h.mainPlaying = true
        c.onPlaying()
        h.run(4_000L)
        assertOver(h, c)
        assertEquals(21, h.ins.size)
    }

    @Test
    fun aSeekSkipNewListErrorOrSettingMidFadeStopsItAtOnce() {
        val events = listOf<(Crossfader) -> Unit>(
            { it.onJump() },
            { it.onHalted() },
            { it.setSetting(10_000) },
            { it.setSetting(0) },
        )
        for ((i, event) in events.withIndex()) {
            val (h, c) = fading()
            event(c)
            assertDropped(h, c)
            // Nothing of it comes back: the old track ends the usual way.
            val volumes = h.mainVolumes.size
            h.run(4_000L)
            assertEquals("event $i", volumes, h.mainVolumes.size)
            assertEquals("event $i", 0, h.handOvers)
        }
        // The same setting again changes nothing.
        val (h, c) = fading()
        c.setSetting(6_000)
        assertEquals(Crossfader.Phase.CROSSING, c.phase)
        assertTrue(h.hasIncoming)
    }

    @Test
    fun theIncomingTrackFailingLetsTheOldOnePlayOnAsWithCrossfadeOff() {
        val (h, c) = fading()
        c.onIncomingFailed()
        assertDropped(h, c)
        // It plays to its end and on (no stop there, no hand-over).
        h.run(4_000L)
        assertEquals(0, h.handOvers)
        assertEquals(dur, h.position)
        // A late second word of it changes nothing.
        c.onIncomingFailed()
        assertEquals(1, h.drops)
    }

    @Test
    fun anEditMidFadeStopsItOnlyIfTheNextTrackChanged() {
        val (h, c) = fading()
        // Something added further down: the hand-over brings the incoming player's list in step.
        c.onListChanged()
        assertEquals(Crossfader.Phase.CROSSING, c.phase)
        assertTrue(h.hasIncoming)
        // The next track removed, or another one moved before it: the fade stops.
        h.incomingNext = false
        c.onListChanged()
        assertDropped(h, c)
    }

    @Test
    fun aJumpWhileRisingEndsTheFadeAtFullVolume() {
        val (h, c) = handedOverLate()
        assertTrue(h.mainLevel < 1f)
        c.onJump()
        assertOver(h, c)
    }

    @Test
    fun theOldTrackStoppingAtItsEndOutsideAFadeIsIgnored() {
        val (h, c) = armed()
        c.onMainEnded()
        assertEquals(0, h.handOvers)
        assertEquals(Crossfader.Phase.NONE, c.phase)
    }

    @Test
    fun ourOwnHostCallsEventsAreNotTheUsers() {
        val (h, c) = armed()
        val seen = ArrayList<Crossfader.Phase>()
        val all: () -> Unit = {
            // The players' events while we set them up: a transition, a list, play wanted, an end.
            c.onJump()
            c.onHalted()
            c.arm()
            c.onListChanged()
            c.onPlayWanted(true)
            c.onIncomingFailed()
            c.onMainEnded()
            seen.add(c.phase)
        }
        h.onStart = all
        h.onHandOver = all
        h.playTo(fadeAt)
        assertEquals(Crossfader.Phase.CROSSING, c.phase)
        assertTrue(h.hasIncoming)
        h.incomingPlaying = true
        c.onPlaying()
        h.run(6_100L)
        assertOver(h, c)
        assertEquals(2, seen.size)
    }

    @Test
    fun itIsArmedAgainOnEachChange() {
        val (h, c) = armed()
        assertEquals(listOf(fadeAt), h.messages.map { it.first })
        // A shorter next track (its length now known): later, shorter.
        h.nextDuration = 15_000L
        c.onListChanged()
        assertEquals(listOf(dur - 5_000L), h.messages.map { it.first })
        // Another setting.
        h.nextDuration = 3 * min
        c.setSetting(10_000)
        assertEquals(listOf(dur - 10_000L), h.messages.map { it.first })
        // A seek past the fade: nothing set (too late); back before it: set again.
        h.position = dur - 2_000L
        c.onJump()
        assertTrue(h.messages.isEmpty())
        h.position = 60_000L
        c.onJump()
        assertEquals(listOf(dur - 10_000L), h.messages.map { it.first })
        // Another track: its own.
        h.item = "z"
        h.duration = 2 * min
        c.onJump()
        assertEquals(listOf(2 * min - 10_000L), h.messages.map { it.first })
    }

    @Test
    fun aMessageForAnotherTrackDoesNothing() {
        val (h, c) = armed()
        val stale = h.messages.single().second
        h.item = "z"
        stale()
        assertEquals(0, h.starts)
        assertEquals(Crossfader.Phase.NONE, c.phase)
    }

    @Test
    fun aFadeDueWhileTheLastOneStillRisesIsSkipped() {
        val (h, c) = fading()
        // Handed over to a track that buffers: the ramp waits.
        h.incomingPlaying = false
        h.run(3_500L)
        assertEquals(Crossfader.Phase.RISING, c.phase)
        // Its own fade comes due meanwhile.
        h.position = h.duration - 6_010L
        c.arm()
        h.mainPlaying = true
        h.run(20L)
        assertEquals(listOf(Skip.FADING), h.skips)
        assertEquals(1, h.starts)
        assertEquals(Crossfader.Phase.RISING, c.phase)
    }

    @Test
    fun noFadeWhenThePlanSaysNo() {
        for ((facts, why) in listOf(
            CrossfadeTest().facts(playing = false) to Skip.NOT_PLAYING,
            CrossfadeTest().facts(hasNext = false) to Skip.LAST,
            CrossfadeTest().facts(outage = true) to Skip.OUTAGE,
            CrossfadeTest().facts(sameAlbum = true) to Skip.SAME_ALBUM,
            // A next track that can't play: this one plays to its end, the error rules skip that one.
            CrossfadeTest().facts(nextReady = false) to Skip.NEXT_NOT_READY,
        )) {
            val h = FakeHost()
            h.f = facts
            val (_, c) = armed(host = h)
            h.playTo(dur)
            assertEquals(0, h.starts)
            assertEquals(listOf(why), h.skips)
            assertEquals(Crossfader.Phase.NONE, c.phase)
        }
    }

    @Test
    fun repeatOneFadesIntoItself() {
        val h = FakeHost()
        h.f = facts(repeatOne = true, hasNext = false)
        h.nextDuration = dur
        val (_, c) = armed(host = h)
        h.playTo(fadeAt)
        assertEquals(1, h.starts)
        assertEquals(Crossfader.Phase.CROSSING, c.phase)
    }

    @Test
    fun eachSkipIsLoggedOnceAndTheUsualOnesNever() {
        val h = FakeHost()
        val c = Crossfader(h, 6_000)
        // Too late for this track, however often it is armed.
        h.position = dur - 1_000L
        repeat(3) { c.arm() }
        assertEquals(listOf(Skip.TOO_LATE), h.skips)
        // Too short: once for it too.
        h.item = "short"
        h.duration = 2_000L
        h.position = 0L
        repeat(3) { c.arm() }
        assertEquals(listOf(Skip.TOO_LATE, Skip.TOO_SHORT), h.skips)
        // Another too-short track is told again.
        h.item = "short2"
        c.arm()
        assertEquals(listOf(Skip.TOO_LATE, Skip.TOO_SHORT, Skip.TOO_SHORT), h.skips)
        // A length not known yet, or Off: nothing to tell.
        h.item = "c"
        h.duration = -1L
        c.arm()
        c.setSetting(0)
        assertEquals(3, h.skips.size)
    }

    @Test
    fun releaseLeavesNothing() {
        val (h, c) = fading()
        c.release()
        assertDropped(h, c)
        assertTrue(h.messages.isEmpty())
        h.playTo(dur)
        assertEquals(1, h.starts)
        assertEquals(0, h.handOvers)
    }
}
