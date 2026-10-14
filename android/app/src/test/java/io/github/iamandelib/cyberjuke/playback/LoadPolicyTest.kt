package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.EOFException
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class LoadPolicyTest {
    @Test
    fun theBufferIsWhatDefaultLoadControlAccepts() {
        // DefaultLoadControl.Builder throws at service start unless these hold.
        assertTrue(BufferPolicy.START_MS >= 0)
        assertTrue(BufferPolicy.AFTER_REBUFFER_MS >= 0)
        assertTrue(BufferPolicy.MIN_MS >= BufferPolicy.START_MS)
        assertTrue(BufferPolicy.MIN_MS >= BufferPolicy.AFTER_REBUFFER_MS)
        assertTrue(BufferPolicy.MAX_MS >= BufferPolicy.MIN_MS)
        assertTrue(BufferPolicy.BACK_MS >= 0)
        assertTrue(BufferPolicy.TARGET_BYTES > 0)
    }

    @Test
    fun tenMinutesOfTheBestAudioFitTheMemoryCap() {
        val bytesPerSecondAt160k = 160_000 / 8
        assertTrue(bytesPerSecondAt160k.toLong() * BufferPolicy.MAX_MS / 1000 <= BufferPolicy.TARGET_BYTES)
        // Two minutes ahead, half a minute behind (Media3's default ahead is 50 s).
        assertEquals(120_000, BufferPolicy.MIN_MS)
        assertEquals(30_000, BufferPolicy.BACK_MS)
    }

    @Test
    fun onlyThePlayingAndTheNextTrackOpenTheirStream() {
        val pair = setOf("current____", "next_______")
        assertTrue(OpenGate.mayOpen("current____", pair))
        assertTrue(OpenGate.mayOpen("next_______", pair))
        // The track after next, prepared early: waits (no extraction, no idle connection).
        assertFalse(OpenGate.mayOpen("after_next_", pair))
        // Nothing set yet (or the list emptied): no gate.
        assertTrue(OpenGate.mayOpen("anything___", emptySet()))
    }

    @Test
    fun aWaitingOpenGoesOnOnceItsTurnComes() {
        val gate = OpenGate()
        gate.allow(setOf("a", "b"))
        gate.await("a") // its turn: no wait
        val done = CountDownLatch(1)
        val t = waiter {
            gate.await("c")
            done.countDown()
        }
        try {
            assertFalse(done.await(200, TimeUnit.MILLISECONDS))
            // Skipped on: "c" is next now.
            gate.allow(setOf("b", "c"))
            assertTrue(done.await(5, TimeUnit.SECONDS))
        } finally {
            // Whatever failed above, nothing is left waiting.
            gate.allow(emptySet())
            t.interrupt()
            t.join(5_000)
        }
    }

    /** A daemon thread running [body] (it can never keep the test JVM alive). */
    private fun waiter(body: () -> Unit): Thread = Thread {
        try {
            body()
        } catch (_: InterruptedIOException) {
        }
    }.apply {
        isDaemon = true
        start()
    }

    @Test
    fun aCancelledLoadStopsWaiting() {
        val gate = OpenGate()
        gate.allow(setOf("a", "b"))
        val thrown = AtomicReference<Throwable?>()
        val started = CountDownLatch(1)
        val t = Thread {
            started.countDown()
            try {
                gate.await("c")
            } catch (e: Throwable) {
                thrown.set(e)
            }
        }.apply {
            isDaemon = true
            start()
        }
        try {
            assertTrue(started.await(5, TimeUnit.SECONDS))
            Thread.sleep(100)
            // ExoPlayer's Loader interrupts a load it cancels or releases.
            t.interrupt()
            t.join(5_000)
            assertFalse(t.isAlive)
            assertTrue(thrown.get() is InterruptedIOException)
        } finally {
            gate.allow(emptySet())
            t.interrupt()
        }
    }

    @Test
    fun onlyTheNextItemLoadsAhead() {
        // Playing item 3, item 4 next: 3 and 4 load, 5 and on wait.
        assertTrue(LoadAhead.mayLoad(3, 3, 4))
        assertTrue(LoadAhead.mayLoad(4, 3, 4))
        assertFalse(LoadAhead.mayLoad(5, 3, 4))
        assertFalse(LoadAhead.mayLoad(6, 3, 4))
        // Shuffle: next in play order, whatever its index.
        assertTrue(LoadAhead.mayLoad(0, 3, 0))
        assertFalse(LoadAhead.mayLoad(4, 3, 0))
        // The last item (nothing next): only it.
        assertFalse(LoadAhead.mayLoad(0, 7, LoadAhead.UNSET))
        // Unknown: nothing is held back.
        assertTrue(LoadAhead.mayLoad(LoadAhead.UNSET, 3, 4))
        assertTrue(LoadAhead.mayLoad(9, LoadAhead.UNSET, LoadAhead.UNSET))
    }

    @Test
    fun theNextTrackIsReadiedEarlyWithGaplessOnOrACrossfadeSet() {
        assertTrue(LoadAhead.wanted(gapless = true, crossfadeMs = 0))
        assertTrue(LoadAhead.wanted(gapless = true, crossfadeMs = 6_000))
        // A crossfade needs the next track buffered, Gapless off or not.
        assertTrue(LoadAhead.wanted(gapless = false, crossfadeMs = 3_000))
        assertFalse(LoadAhead.wanted(gapless = false, crossfadeMs = 0))
    }

    @Test
    fun withGaplessOffOnlyTheCurrentTrackLoads() {
        assertEquals(4, LoadAhead.nextToLoad(wanted = true, next = 4))
        assertEquals(LoadAhead.UNSET, LoadAhead.nextToLoad(wanted = false, next = 4))
        assertEquals(LoadAhead.UNSET, LoadAhead.nextToLoad(wanted = true, next = LoadAhead.UNSET))
        // Playing item 3 with no next to load: item 4 waits until it becomes current.
        assertFalse(LoadAhead.mayLoad(4, 3, LoadAhead.UNSET))
        assertTrue(LoadAhead.mayLoad(3, 3, LoadAhead.UNSET))
    }

    @Test
    fun theHeldBackNextTrackOpensWhenThisOneStallsAtItsEnd() {
        // ExoPlayer stalls at the end of a track whose successor isn't prepared: that is the cue.
        assertTrue(LoadAhead.atEnd(positionMs = 180_000L, durationMs = 180_000L))
        assertTrue(LoadAhead.atEnd(positionMs = 177_000L, durationMs = 180_000L))
        assertTrue(LoadAhead.atEnd(positionMs = 180_400L, durationMs = 180_000L))
        // A rebuffer mid-track is not.
        assertFalse(LoadAhead.atEnd(positionMs = 176_999L, durationMs = 180_000L))
        assertFalse(LoadAhead.atEnd(positionMs = 0L, durationMs = 180_000L))
        // Length unknown: any stall may be the end.
        assertTrue(LoadAhead.atEnd(positionMs = 5_000L, durationMs = -1L))
    }

    @Test
    fun aBrokenConnectionOrAResolverNetworkFailureBacksOffLonger() {
        // A reset socket, an HTTP transport error, or the resolver not reaching YouTube (after a
        // change of network): the capped back-off.
        assertTrue(LoadRetry.isNetwork(httpStatus = false, resolverNetwork = false, httpTransport = true, transportCause = false))
        assertTrue(LoadRetry.isNetwork(httpStatus = false, resolverNetwork = false, httpTransport = false, transportCause = true))
        assertTrue(LoadRetry.isNetwork(httpStatus = false, resolverNetwork = true, httpTransport = false, transportCause = false))
        // An HTTP status (5xx), or anything else (a parser error): the default delays.
        assertFalse(LoadRetry.isNetwork(httpStatus = true, resolverNetwork = false, httpTransport = true, transportCause = true))
        assertFalse(LoadRetry.isNetwork(httpStatus = false, resolverNetwork = false, httpTransport = false, transportCause = false))
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 8_000L, 8_000L), (1..6).map { LoadRetry.retryDelayMs(it, network = true) })
    }

    @Test
    fun noErrorTheDefaultWouldRetryIsEverGivenUpOnEarly() {
        // Giving up (TIME_UNSET) would stop the loader for good: after a handover the link would
        // never be fetched again. Every count gets a delay; the minimum retry count decides when
        // the player hears of it.
        assertEquals(listOf(0L, 1_000L, 2_000L, 3_000L, 4_000L, 5_000L, 5_000L, 5_000L), (1..8).map { LoadRetry.retryDelayMs(it, network = false) })
        for (n in 1..20) {
            assertTrue(LoadRetry.retryDelayMs(n, network = true) > 0L)
            assertTrue(LoadRetry.retryDelayMs(n, network = false) >= 0L)
        }
    }

    @Test
    fun transportFailuresAreFoundAmongTheCauses() {
        assertTrue(LoadRetry.hasTransportCause(IOException("wrapped", SocketException("Connection reset"))))
        assertTrue(LoadRetry.hasTransportCause(SocketTimeoutException("read timed out")))
        assertTrue(LoadRetry.hasTransportCause(IOException(UnknownHostException("rr1---sn.googlevideo.com"))))
        assertTrue(LoadRetry.hasTransportCause(RuntimeException(EOFException())))
        assertFalse(LoadRetry.hasTransportCause(IOException("Unexpected response")))
        assertFalse(LoadRetry.hasTransportCause(IllegalStateException("parser")))
    }

    @Test
    fun networkRetriesBackOffAndAreCapped() {
        assertEquals(6, LoadRetry.NETWORK_RETRIES)
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 8_000L, 8_000L, 8_000L), (1..7).map { LoadRetry.delayMs(it) })
        assertEquals(1_000L, LoadRetry.delayMs(0)) // never below the first step
        assertEquals(LoadRetry.MAX_DELAY_MS, LoadRetry.delayMs(Int.MAX_VALUE))
        // All six retries take about half a minute: what two minutes of buffer cover easily.
        assertEquals(31_000L, (1..LoadRetry.NETWORK_RETRIES).sumOf { LoadRetry.delayMs(it) })
    }

    @Test
    fun aCacheFileThatWentAwayIsRetriedSoon() {
        // A YouTube load whose cache file was deleted (low storage) or broken: retried at once-ish
        // (the cache drops the span, the retry fetches it), not a dead track.
        assertEquals(LoadRetry.CACHE_RETRY_MS, LoadRetry.cacheFileRetryMs(ytLoad = true, fileError = true))
        assertNull(LoadRetry.cacheFileRetryMs(ytLoad = false, fileError = true))
        assertNull(LoadRetry.cacheFileRetryMs(ytLoad = true, fileError = false))
    }
}
