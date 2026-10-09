package io.github.iamandelib.cyberjuke.yt

import io.github.iamandelib.cyberjuke.net.BlockReason
import io.github.iamandelib.cyberjuke.net.BlockedException
import io.github.iamandelib.cyberjuke.net.Families
import io.github.iamandelib.cyberjuke.net.Family
import io.github.iamandelib.cyberjuke.net.Ipv4Mode
import io.github.iamandelib.cyberjuke.net.LimitPolicy
import io.github.iamandelib.cyberjuke.net.NetBlock
import io.github.iamandelib.cyberjuke.net.NetPrefs
import io.github.iamandelib.cyberjuke.net.Surface
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.schabi.newpipe.extractor.exceptions.PrivateContentException
import org.schabi.newpipe.extractor.exceptions.SignInConfirmNotBotException

class YtGuardTest {
    private val slept = ArrayList<Long>()
    private val changes = ArrayList<Boolean>()

    @Before
    fun setUp() {
        NetBlock.resetForTest()
        NetPrefs.resetForTest()
        NetBlock.clock = { 0L }
        NetPrefs.clock = { 0L }
        NetPrefs.onChange = { changes.add(it) }
        YtGuard.sleep = { slept.add(it) }
    }

    @After
    fun tearDown() {
        NetBlock.resetForTest()
        NetPrefs.resetForTest()
        YtGuard.sleep = { Thread.sleep(it) }
    }

    private fun botCheck() = SignInConfirmNotBotException("Sign in to confirm you're not a bot")

    /** Work whose attempts go out over [families] in turn and fail while [fails] says so. */
    private fun attempts(families: List<Family>, fails: (Int) -> Boolean): Pair<() -> String, () -> Int> {
        var n = 0
        val work = {
            Families.record(families[minOf(n, families.size - 1)])
            val i = n++
            if (fails(i)) throw botCheck()
            "ok"
        }
        return work to { n }
    }

    @Test
    fun aLimitOverIpv6SwitchesToIpv4AndRetriesAtOnce() {
        val (work, count) = attempts(listOf(Family.IPV6, Family.IPV4)) { it == 0 }
        assertEquals("ok", YtGuard.run(Surface.PLAYBACK, work))
        assertEquals(2, count())
        assertEquals(emptyList<Long>(), slept) // no wait
        assertTrue(NetPrefs.preferIpv4)
        assertEquals(listOf(true), changes) // persisted, cached URLs dropped
        assertFalse(NetBlock.isBlocked()) // no banner
    }

    @Test
    fun onIpv4ItWaitsAndRetriesOnceBeforeBlocking() {
        val (work, count) = attempts(listOf(Family.IPV4)) { it == 0 }
        assertEquals("ok", YtGuard.run(Surface.PLAYBACK, work))
        assertEquals(2, count())
        assertEquals(listOf(LimitPolicy.RETRY_DELAY_MS), slept)
        assertFalse(NetBlock.isBlocked())

        val (always, n2) = attempts(listOf(Family.IPV4)) { true }
        try {
            YtGuard.run(Surface.PLAYBACK, always)
            fail("expected the bot check")
        } catch (e: SignInConfirmNotBotException) {
            // the original failure, after the back-off started
        }
        assertEquals(2, n2())
        assertEquals(BlockReason.BOT_CHECK, NetBlock.active().second)
    }

    @Test
    fun switchedAndStillRefusedItRetriesOnceThenBlocks() {
        val (work, count) = attempts(listOf(Family.IPV6, Family.IPV4)) { true }
        try {
            YtGuard.run(Surface.PLAYBACK, work)
            fail("expected the bot check")
        } catch (e: SignInConfirmNotBotException) {
        }
        assertEquals(3, count()) // IPv6, then IPv4, then IPv4 after the wait
        assertEquals(listOf(LimitPolicy.RETRY_DELAY_MS), slept)
        assertTrue(NetBlock.isBlocked())
    }

    @Test
    fun noSwitchUnlessTheSettingIsAuto() {
        NetPrefs.load(Ipv4Mode.OFF, emptyMap())
        val (work, count) = attempts(listOf(Family.IPV6)) { true }
        runCatching { YtGuard.run(Surface.PLAYBACK, work) }
        assertEquals(2, count())
        assertFalse(NetPrefs.preferIpv4)
    }

    @Test
    fun musicLimitsHoldMusicOnly() {
        val (work, _) = attempts(listOf(Family.IPV4)) { true }
        runCatching { YtGuard.run(Surface.MUSIC, work) }
        assertTrue(NetBlock.isBlocked(Surface.MUSIC))
        assertFalse(NetBlock.isBlocked(Surface.PLAYBACK))
        // Refused up front now, without a request.
        val (next, count) = attempts(listOf(Family.IPV4)) { false }
        try {
            YtGuard.run(Surface.MUSIC, next)
            fail("expected BlockedException")
        } catch (e: BlockedException) {
        }
        assertEquals(0, count())
        assertEquals("ok", YtGuard.run(Surface.PLAYBACK, next))
    }

    @Test
    fun otherFailuresPassStraightThrough() {
        var n = 0
        try {
            YtGuard.run(Surface.PLAYBACK) {
                n++
                throw PrivateContentException("private")
            }
            fail("expected the failure")
        } catch (e: PrivateContentException) {
        }
        assertEquals(1, n)
        assertEquals(emptyList<Long>(), slept)
        assertFalse(NetBlock.isQuiet())
    }

    @Test
    fun anInterruptedWaitStopsAsACancelledLoad() {
        YtGuard.sleep = { throw InterruptedException() }
        val (work, _) = attempts(listOf(Family.IPV4)) { true }
        try {
            YtGuard.run(Surface.PLAYBACK, work)
            fail("expected InterruptedIOException")
        } catch (e: java.io.InterruptedIOException) {
        }
        assertTrue(Thread.interrupted()) // the flag is kept (and cleared here)
        assertFalse(NetBlock.isBlocked())
    }
}
