package io.github.iamandelib.cyberjuke.net

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.asResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import okio.ByteString.Companion.decodeHex
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BodyLimitTest {
    @After
    fun tearDown() = NetPrefs.resetForTest()

    /** A body of [text] that doesn't say how long it is (chunked, or gzip OkHttp unpacked). */
    private fun unsized(text: String): ResponseBody = Buffer().writeUtf8(text).asResponseBody(null, -1L)

    @Test
    fun aBodyUpToTheCapIsReadWhole() {
        assertEquals("{\"ok\":true}", "{\"ok\":true}".toResponseBody().stringAtMost(1024))
        assertEquals("x".repeat(100), "x".repeat(100).toResponseBody().stringAtMost(100))
        assertEquals("y".repeat(100), unsized("y".repeat(100)).stringAtMost(100))
        assertEquals("", "".toResponseBody().stringAtMost(0))
    }

    @Test
    fun aDeclaredLengthOverTheCapFailsBeforeReading() {
        val data = Buffer().writeUtf8("z".repeat(50))
        val body = data.asResponseBody(null, 5_000_000L)
        assertThrows(BodyTooLargeException::class.java) { body.stringAtMost(1_000_000) }
        assertEquals(50L, data.size) // nothing was taken from the source
    }

    @Test
    fun aBodyWithoutALengthFailsOncePastTheCap() {
        assertThrows(BodyTooLargeException::class.java) { unsized("w".repeat(101)).stringAtMost(100) }
        assertThrows(BodyTooLargeException::class.java) { "v".repeat(101).toResponseBody().stringAtMost(100) }
    }

    @Test
    fun readsTheCharsetAndByteOrderMarkLikeString() {
        val latin1 = Buffer().write("e9".decodeHex()).asResponseBody("text/plain; charset=ISO-8859-1".toMediaType(), 1L)
        assertEquals("é", latin1.stringAtMost(16))
        val bom = Buffer().write("efbbbf".decodeHex()).writeUtf8("[]").asResponseBody(null, 5L)
        assertEquals("[]", bom.stringAtMost(16))
    }

    @Test
    fun onlyNonStreamingCallsHaveAnOverallTimeout() {
        for (ipv4 in listOf(false, true)) {
            NetPrefs.setMode(if (ipv4) Ipv4Mode.ALWAYS else Ipv4Mode.OFF)
            assertEquals(Http.CALL_S * 1000, Http.current().callTimeoutMillis.toLong())
            assertEquals(0, Http.currentStreaming().callTimeoutMillis)
            assertEquals(Http.STREAM_READ_S * 1000, Http.currentStreaming().readTimeoutMillis.toLong())
        }
    }
}
