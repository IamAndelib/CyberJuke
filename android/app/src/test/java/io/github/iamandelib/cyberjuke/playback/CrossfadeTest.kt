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
    ) = CrossfadePlan.Facts(settingMs, playing, repeatOne, hasNext, outage, gapless, sameAlbum, fading)

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
    fun theNextTrackNeedNotBeBufferedOrEvenKnown() {
        // The fade waits for the incoming track when it needs a moment: nothing about it is asked
        // beforehand but its length, when known, to shrink the fade.
        assertEquals(Trigger.At(4 * min - 6_000L, 6_000L), CrossfadePlan.trigger(6_000L, 4 * min, -1L, 0L))
        assertNull(CrossfadePlan.decide(facts()))
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
     * The service's players and handler, by hand. [run] lets time pass: the main player's position
     * moves while it plays, its messages run as it passes them, posted steps as they come due, and
     * the focus barrier once its turn comes ([autoBarrier]; else [barrier]).
     */
    private class FakeHost : Crossfader.Host {
        var f = CrossfadeTest().facts()
        var duration = 4 * 60_000L
        var nextDuration = 3 * 60_000L
        var position = 0L
        var clock = 0L
        var item: Any? = "a"
        override var mainPlaying = true
        var mainLevel = 1f
        val mainVolumes = ArrayList<Float>()

        /** The fading player: its volume, whether it plays, and whether it was released. */
        var fadingLevel = 0f
        var fadingOn = false
        val fadingVolumes = ArrayList<Float>()
        var fadingReleased = 0
        var hasFading = false

        val messages = ArrayList<Pair<Long, () -> Unit>>()
        val posted = ArrayList<Pair<Long, Runnable>>()
        var autoBarrier = true
        var barrierDue: (() -> Unit)? = null
        var yields = 0
        var reclaims = 0
        var swaps = 0
        var swapWorks = true
        var onSwap: () -> Unit = {}
        val skips = ArrayList<Skip>()
        val starts = ArrayList<Long>()

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

        override fun yieldFocus(then: () -> Unit) {
            yields++
            barrierDue = then
        }

        fun barrier() {
            val then = barrierDue ?: return
            barrierDue = null
            then()
        }

        override fun reclaimFocus() {
            reclaims++
        }

        /** As the service: the new player at the next track's start, silent and not playing yet; the old one fading. */
        override fun swapToNext(): Boolean {
            if (!swapWorks) return false
            swaps++
            check(!hasFading) { "a second fading player" }
            hasFading = true
            fadingLevel = mainLevel
            fadingOn = true
            item = "n$swaps"
            position = 0L
            duration = nextDuration
            mainLevel = 0f
            mainPlaying = false
            onSwap()
            return true
        }

        override fun setMainVolume(v: Float) {
            mainLevel = v
            mainVolumes.add(v)
        }

        override fun setFadingVolume(v: Float) {
            check(hasFading) { "no fading player" }
            fadingLevel = v
            fadingVolumes.add(v)
        }

        override fun setFadingPlaying(playing: Boolean) {
            check(hasFading) { "no fading player" }
            fadingOn = playing
        }

        override fun releaseFading() {
            check(hasFading) { "released twice" }
            hasFading = false
            fadingOn = false
            fadingReleased++
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
            starts.add(fadeMs)
        }

        fun run(ms: Long, tick: Long = 10L) {
            var left = ms
            while (left > 0L) {
                val d = minOf(tick, left)
                left -= d
                if (autoBarrier) barrier()
                val from = position
                clock += d
                if (mainPlaying) position = minOf(position + d, duration)
                for (m in messages.filter { it.first in (from + 1)..position }) if (messages.remove(m)) m.second()
                for (p in posted.filter { it.first <= clock }.sortedBy { it.first }) if (posted.remove(p)) p.second.run()
            }
        }

        /** Plays the main player to [to] (its position), whatever time that takes. */
        fun playTo(to: Long) {
            mainPlaying = true
            run(to - position)
        }
    }

    private val dur = 4 * min
    private val fadeAt = dur - 6_000L

    private fun armed(settingMs: Int = 6_000): Pair<FakeHost, Crossfader> {
        val h = FakeHost()
        val c = Crossfader(h, settingMs)
        c.arm()
        return h to c
    }

    /** Swapped at the fade's start: the new player buffering its first moments, nothing ramped yet. */
    private fun swapped(own: Float = 1f): Pair<FakeHost, Crossfader> {
        val (h, c) = armed()
        h.mainLevel = own
        h.playTo(fadeAt)
        h.run(10L)
        assertEquals(Crossfader.Phase.FADING, c.phase)
        return h to c
    }

    /** In the middle of a 6 s fade: the new player playing, ten of the twenty steps done. */
    private fun fading(own: Float = 1f): Pair<FakeHost, Crossfader> {
        val (h, c) = swapped(own)
        h.mainPlaying = true
        c.onPlaying()
        h.run(10 * 300L - 10L)
        assertEquals(Crossfader.Phase.FADING, c.phase)
        return h to c
    }

    /** The fade is over or stopped: the old player released once, no step left, the new one at [own]. */
    private fun assertOver(h: FakeHost, c: Crossfader, own: Float = 1f) {
        assertEquals(Crossfader.Phase.NONE, c.phase)
        assertFalse(h.hasFading)
        assertEquals(1, h.fadingReleased)
        assertTrue("no step left", h.posted.isEmpty())
        assertEquals(own, h.mainLevel, 0f)
    }

    @Test
    fun offSetsNothing() {
        val (h, c) = armed(settingMs = 0)
        h.playTo(dur)
        assertTrue(h.messages.isEmpty())
        assertEquals(0, h.yields)
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

        h.autoBarrier = false
        h.playTo(fadeAt)
        // The old player gives up its audio focus first; the swap waits for that.
        assertEquals(Crossfader.Phase.YIELDING, c.phase)
        assertEquals(1, h.yields)
        assertEquals(0, h.swaps)

        h.barrier()
        // Swapped: the next track on the new player, silent; the old one at its own volume.
        assertEquals(Crossfader.Phase.FADING, c.phase)
        assertEquals(1, h.swaps)
        assertEquals(listOf(6_000L), h.starts)
        assertEquals(0f, h.mainLevel, 0f)
        assertEquals(1f, h.fadingLevel, 0f)
        // The new track buffers its first moments: the ramp waits for it.
        h.run(500L)
        assertTrue(h.mainVolumes.isEmpty())
        assertTrue(h.fadingVolumes.isEmpty())

        h.mainPlaying = true
        c.onPlaying()
        h.run(6_000L)
        assertOver(h, c)
        // Twenty steps of 300 ms along the curve, then the end at full volume: 21 in all.
        assertEquals(21, h.mainVolumes.size)
        for (i in 0 until 20) {
            assertEquals(CrossfadePlan.fadeIn(i / 20f), h.mainVolumes[i], 1e-6f)
            assertEquals(CrossfadePlan.fadeOut(i / 20f), h.fadingVolumes[i], 1e-6f)
        }
        assertEquals(20, h.fadingVolumes.size)
        assertEquals(1f, h.mainVolumes.last(), 0f)
        assertEquals(h.mainVolumes.sorted(), h.mainVolumes)
        assertEquals(h.fadingVolumes.sortedDescending(), h.fadingVolumes)
        assertTrue(h.skips.isEmpty())
        assertEquals(0, h.reclaims)
    }

    @Test
    fun theRampTakesTheFadesLength() {
        val (h, c) = swapped()
        h.mainPlaying = true
        c.onPlaying()
        val from = h.clock
        while (c.phase == Crossfader.Phase.FADING) h.run(10L)
        assertTrue(h.clock - from in 6_000L..6_010L)
    }

    @Test
    fun theFadeFollowsTheOldPlayersOwnVolume() {
        val (h, c) = fading(own = 0.5f)
        assertEquals(0.5f * CrossfadePlan.fadeIn(9 / 20f), h.mainLevel, 1e-6f)
        assertEquals(0.5f * CrossfadePlan.fadeOut(9 / 20f), h.fadingLevel, 1e-6f)
        h.run(4_000L)
        assertOver(h, c, own = 0.5f)
    }

    @Test
    fun theNewTrackIsArmedAtTheSwapOrOnceItsLengthIsKnown() {
        // The fake knows the new track's length (3 min) at once.
        val (h, _) = swapped()
        assertEquals(listOf(3 * min - 6_000L), h.messages.map { it.first })
        // Not known yet at the swap: nothing set until it is.
        val (h2, c2) = armed()
        h2.onSwap = { h2.duration = -1L }
        h2.playTo(fadeAt)
        h2.run(10L)
        assertEquals(Crossfader.Phase.FADING, c2.phase)
        assertTrue(h2.messages.isEmpty())
        h2.duration = 3 * min
        c2.arm()
        assertEquals(listOf(3 * min - 6_000L), h2.messages.map { it.first })
    }

    @Test
    fun theNewTrackFadesIntoTheOneAfterIt() {
        val (h, c) = fading()
        h.run(4_000L)
        assertEquals(Crossfader.Phase.NONE, c.phase)
        // The fake gave the new track the next track's length (3 min).
        assertEquals(listOf(3 * min - 6_000L), h.messages.map { it.first })
        h.playTo(3 * min - 6_000L)
        h.run(10L)
        assertEquals(2, h.swaps)
        assertEquals(Crossfader.Phase.FADING, c.phase)
    }

    @Test
    fun abortedWhileYieldingTheFocusComesBackAndNothingIsSwapped() {
        val events = listOf<(Crossfader, FakeHost) -> Unit>(
            { c, _ -> c.onJump() },
            { c, _ -> c.onHalted() },
            { c, _ -> c.onPlayWanted(false) },
            { c, _ -> c.setSetting(3_000) },
            { c, _ -> c.release() },
        )
        for ((i, event) in events.withIndex()) {
            val (h, c) = armed()
            h.autoBarrier = false
            h.playTo(fadeAt)
            assertEquals(Crossfader.Phase.YIELDING, c.phase)
            event(c, h)
            assertEquals("event $i", Crossfader.Phase.NONE, c.phase)
            assertEquals("event $i", 1, h.reclaims)
            // The barrier's late callback changes nothing.
            h.barrier()
            assertEquals("event $i", 0, h.swaps)
            assertEquals("event $i", Crossfader.Phase.NONE, c.phase)
            assertTrue(h.mainVolumes.isEmpty())
        }
    }

    @Test
    fun aFailedSwapGivesTheFocusBackAndSaysSo() {
        val (h, c) = armed()
        h.swapWorks = false
        h.playTo(fadeAt)
        h.run(10L)
        assertEquals(Crossfader.Phase.NONE, c.phase)
        assertEquals(1, h.reclaims)
        assertEquals(listOf(Skip.NO_PLAYER), h.skips)
        assertTrue(h.starts.isEmpty())
        assertEquals(0, h.fadingReleased)
        assertTrue(h.mainVolumes.isEmpty())
        // The track plays to its end the usual way.
        h.playTo(dur)
        assertEquals(1, h.yields)
    }

    @Test
    fun aPauseOrACallMidFadeHoldsBothPlayersAndTheRamp() {
        val (h, c) = fading()
        val steps = h.mainVolumes.size
        // Paused (or held back by a call): the old player stops too, and no step is taken.
        c.onPlayWanted(false)
        h.mainPlaying = false
        assertFalse(h.fadingOn)
        h.run(5_000L)
        assertEquals(steps, h.mainVolumes.size)
        assertEquals(Crossfader.Phase.FADING, c.phase)
        assertEquals(0, h.fadingReleased)
        // Playing again: both go on, the ramp where it was.
        c.onPlayWanted(true)
        assertTrue(h.fadingOn)
        h.mainPlaying = true
        c.onPlaying()
        assertEquals(steps + 1, h.mainVolumes.size)
        h.run(4_000L)
        assertOver(h, c)
    }

    @Test
    fun theIncomingTrackBufferingMidFadeOnlyHoldsTheRamp() {
        val (h, c) = fading()
        val steps = h.mainVolumes.size
        // Buffering: play is still wanted, the old track plays on.
        h.mainPlaying = false
        h.run(2_000L)
        assertEquals(steps, h.mainVolumes.size)
        assertTrue(h.fadingOn)
        assertTrue(h.posted.isEmpty())
        h.mainPlaying = true
        c.onPlaying()
        h.run(4_000L)
        assertOver(h, c)
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
            assertOver(h, c)
            // Nothing of it comes back.
            val volumes = h.mainVolumes.size
            h.run(1_000L)
            assertEquals("event $i", volumes, h.mainVolumes.size)
        }
        // The same setting again changes nothing.
        val (h, c) = fading()
        c.setSetting(6_000)
        assertEquals(Crossfader.Phase.FADING, c.phase)
        assertTrue(h.hasFading)
    }

    @Test
    fun theOldTrackEndingOrFailingMidFadeLetsTheRampFinish() {
        val (h, c) = fading()
        val before = h.mainLevel
        val outs = h.fadingVolumes.size
        c.onFadingGone()
        assertFalse(h.hasFading)
        assertEquals(1, h.fadingReleased)
        assertEquals(Crossfader.Phase.FADING, c.phase)
        // No jump: the incoming track keeps rising along the curve, alone.
        assertEquals(before, h.mainLevel, 0f)
        h.run(300L)
        assertTrue(h.mainLevel > before && h.mainLevel < 1f)
        h.run(4_000L)
        assertOver(h, c)
        assertEquals(outs, h.fadingVolumes.size)
        // A late second word of it changes nothing.
        c.onFadingGone()
        assertEquals(1, h.fadingReleased)
    }

    @Test
    fun theNewPlayerNotPlayingAtFirstHoldsTheRampAtSilence() {
        val (h, c) = swapped()
        h.run(3_000L)
        assertTrue(h.mainVolumes.isEmpty())
        assertEquals(0f, h.mainLevel, 0f)
        assertEquals(1f, h.fadingLevel, 0f)
        assertTrue(h.posted.isEmpty())
        // A play-wanted change meanwhile (the user pressed Play again) only re-arms.
        c.onPlayWanted(true)
        assertTrue(h.fadingOn)
        assertEquals(Crossfader.Phase.FADING, c.phase)
    }

    @Test
    fun ourOwnSwapsEventsAreNotTheUsers() {
        val (h, c) = armed()
        var during: Crossfader.Phase? = null
        h.onSwap = {
            // The new player's events while it is set up: a transition, its list, play wanted.
            c.onJump()
            c.onHalted()
            c.arm()
            c.onPlayWanted(true)
            during = c.phase
        }
        h.playTo(fadeAt)
        h.run(10L)
        assertEquals(Crossfader.Phase.YIELDING, during)
        assertEquals(Crossfader.Phase.FADING, c.phase)
        assertEquals(0, h.reclaims)
        assertTrue(h.hasFading)
    }

    @Test
    fun itIsArmedAgainOnEachChange() {
        val (h, c) = armed()
        assertEquals(listOf(fadeAt), h.messages.map { it.first })
        // A shorter next track (its length now known): later, shorter.
        h.nextDuration = 15_000L
        c.arm()
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
        assertEquals(0, h.yields)
        assertEquals(Crossfader.Phase.NONE, c.phase)
    }

    @Test
    fun aFadeDueDuringAFadeIsSkipped() {
        val (h, c) = fading()
        // The new track's own fade comes due while this one still runs (the ramp held back).
        h.position = h.duration - 6_010L
        c.arm()
        h.run(20L)
        assertEquals(listOf(Skip.FADING), h.skips)
        assertEquals(1, h.swaps)
        assertEquals(Crossfader.Phase.FADING, c.phase)
    }

    @Test
    fun noFadeWhenThePlanSaysNo() {
        for ((facts, why) in listOf(
            CrossfadeTest().facts(playing = false) to Skip.NOT_PLAYING,
            CrossfadeTest().facts(hasNext = false) to Skip.LAST,
            CrossfadeTest().facts(outage = true) to Skip.OUTAGE,
            CrossfadeTest().facts(sameAlbum = true) to Skip.SAME_ALBUM,
        )) {
            val h = FakeHost()
            h.f = facts
            val c = Crossfader(h, 6_000)
            c.arm()
            h.playTo(dur)
            assertEquals(0, h.yields)
            assertEquals(listOf(why), h.skips)
            assertEquals(Crossfader.Phase.NONE, c.phase)
        }
    }

    @Test
    fun repeatOneFadesIntoItself() {
        val h = FakeHost()
        h.f = facts(repeatOne = true, hasNext = false)
        h.nextDuration = dur
        val c = Crossfader(h, 6_000)
        c.arm()
        h.playTo(fadeAt)
        h.run(10L)
        assertEquals(1, h.swaps)
        assertEquals(Crossfader.Phase.FADING, c.phase)
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
        assertOver(h, c)
        assertTrue(h.messages.isEmpty())
        h.playTo(dur)
        assertEquals(1, h.swaps)
    }
}
