package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

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
    fun networkRetriesBackOffAndAreCapped() {
        assertEquals(6, LoadRetry.NETWORK_RETRIES)
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 8_000L, 8_000L, 8_000L), (1..7).map { LoadRetry.delayMs(it) })
        assertEquals(1_000L, LoadRetry.delayMs(0)) // never below the first step
        assertEquals(LoadRetry.MAX_DELAY_MS, LoadRetry.delayMs(Int.MAX_VALUE))
        // All six retries take about half a minute: what two minutes of buffer cover easily.
        assertEquals(31_000L, (1..LoadRetry.NETWORK_RETRIES).sumOf { LoadRetry.delayMs(it) })
    }
}
