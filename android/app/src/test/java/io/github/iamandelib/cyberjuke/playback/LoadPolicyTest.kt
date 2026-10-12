package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.EOFException
import java.io.IOException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

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
    fun onlyABrokenConnectionGetsTheLongerRunOfRetries() {
        // A reset socket or an HTTP transport error: six retries, capped back-off.
        assertTrue(LoadRetry.isNetwork(httpStatus = false, resolver = false, httpTransport = true, transportCause = false))
        assertTrue(LoadRetry.isNetwork(httpStatus = false, resolver = false, httpTransport = false, transportCause = true))
        // An HTTP status (5xx) or the resolver: the default count.
        assertFalse(LoadRetry.isNetwork(httpStatus = true, resolver = false, httpTransport = true, transportCause = false))
        assertFalse(LoadRetry.isNetwork(httpStatus = false, resolver = true, httpTransport = false, transportCause = true))
        // Anything else (a parser error): the default count.
        assertFalse(LoadRetry.isNetwork(httpStatus = false, resolver = false, httpTransport = false, transportCause = false))
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 8_000L, 8_000L), (1..6).map { LoadRetry.retryDelayMs(it, network = true) })
        assertEquals(listOf(0L, 1_000L, 2_000L, null), (1..4).map { LoadRetry.retryDelayMs(it, network = false) })
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
}
