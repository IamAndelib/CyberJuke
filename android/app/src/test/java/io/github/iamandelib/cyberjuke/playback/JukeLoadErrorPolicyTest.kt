package io.github.iamandelib.cyberjuke.playback

import androidx.media3.common.C
import io.github.iamandelib.cyberjuke.net.BlockReason
import io.github.iamandelib.cyberjuke.net.BlockedException
import io.github.iamandelib.cyberjuke.net.FailureKind
import io.github.iamandelib.cyberjuke.playback.JukeLoadErrorPolicy.Facts
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.FileNotFoundException
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/** The load error policy's rule ([JukeLoadErrorPolicy.delayFor]): what is retried, when, and what never is. */
class JukeLoadErrorPolicyTest {
    private val never = C.TIME_UNSET
    private val id = "dQw4w9WgXcQ"

    /** A failure wrapped the way the player hands it over (the cause chain). */
    private fun wrapped(cause: Throwable) = IOException("load failed", cause)

    private fun delay(e: Throwable, f: Facts = Facts()) = JukeLoadErrorPolicy.delayFor(e, f)

    @Test
    fun whatCanNeverSucceedIsNeverRetried() {
        assertEquals(never, delay(wrapped(ManifestOnlyException(id, "https://m/x.m3u8", "application/x-mpegURL"))))
        assertEquals(never, delay(wrapped(BlockedException(until = 1L, reason = BlockReason.BOT_CHECK))))
        for (kind in listOf(FailureKind.CONTENT, FailureKind.BOT_CHECK, FailureKind.RATE_LIMIT, FailureKind.BROKEN, FailureKind.OTHER)) {
            assertEquals(kind.name, never, delay(wrapped(ResolveException(id, kind.name, null, kind))))
        }
        // The default's own "never" (a malformed file, an unexpected loader error) stays.
        assertEquals(never, delay(IOException("malformed"), Facts(default = never)))
    }

    @Test
    fun forbiddenGoneAndTooManyRequestsAreNotRetriedHere() {
        for (code in listOf(403, 410, 429)) assertEquals(code.toString(), never, delay(IOException("$code"), Facts(httpCode = code)))
        // Other statuses take the default's delays: 0, 1 s, 2 s... capped at 5 s.
        assertEquals(0L, delay(IOException("500"), Facts(httpCode = 500, errorCount = 1)))
        assertEquals(2_000L, delay(IOException("500"), Facts(httpCode = 500, errorCount = 3)))
        assertEquals(5_000L, delay(IOException("503"), Facts(httpCode = 503, errorCount = 9)))
    }

    @Test
    fun aJukeboxMp3ThatLatexRefusesIsNotRetried() {
        // Gone, private, refused: the file's answer. Skipped at once instead of ~15 s of retries.
        for (code in listOf(400, 401, 403, 404, 410, 429)) {
            assertEquals(code.toString(), never, delay(IOException("$code"), Facts(httpCode = code, mp3Load = true)))
        }
        // latex.gg failing (5xx) or the connection breaking is retried as for anything else.
        assertEquals(2_000L, delay(IOException("503"), Facts(httpCode = 503, mp3Load = true, errorCount = 3)))
        assertEquals(1_000L, delay(wrapped(SocketTimeoutException("read")), Facts(mp3Load = true, errorCount = 1)))
        // A video's 404 is still the default's.
        assertEquals(0L, delay(IOException("404"), Facts(httpCode = 404, ytLoad = true, errorCount = 1)))
    }

    @Test
    fun aCacheFileGoneOnAYouTubeLoadIsFetchedAgainSoon() {
        assertEquals(LoadRetry.CACHE_RETRY_MS, delay(wrapped(FileNotFoundException("span")), Facts(ytLoad = true, default = never)))
        assertEquals(LoadRetry.CACHE_RETRY_MS, delay(IOException("read"), Facts(ytLoad = true, fileError = true, default = never)))
        // A Jukebox MP3 is in the listening cache too: fetched again from latex.gg.
        assertEquals(LoadRetry.CACHE_RETRY_MS, delay(wrapped(FileNotFoundException("span")), Facts(mp3Load = true, default = never)))
        // The same file error on anything else (an asset, a manifest) is what the default says: a dead track.
        assertEquals(never, delay(wrapped(FileNotFoundException("asset")), Facts(ytLoad = false, default = never)))
        // A video that can't play isn't rescued by a cache miss on the same load.
        assertEquals(never, delay(IOException("x", ResolveException(id, "private", FileNotFoundException("f"), FailureKind.CONTENT)), Facts(ytLoad = true)))
    }

    @Test
    fun aBrokenConnectionWaitsWithTheCappedBackOff() {
        val expected = listOf(1_000L, 2_000L, 4_000L, 8_000L, 8_000L, 8_000L)
        for ((i, ms) in expected.withIndex()) {
            val n = i + 1
            assertEquals("timeout $n", ms, delay(wrapped(SocketTimeoutException("read")), Facts(ytLoad = true, errorCount = n)))
            assertEquals("resolver $n", ms, delay(wrapped(ResolveException(id, "offline", UnknownHostException(), FailureKind.NETWORK)), Facts(ytLoad = true, errorCount = n)))
            assertEquals("transport $n", ms, delay(IOException("closed"), Facts(httpTransport = true, errorCount = n)))
        }
        // An HTTP status is an answer, not a broken connection: the default's delays.
        assertEquals(1_000L, delay(wrapped(SocketTimeoutException("read")), Facts(httpCode = 502, errorCount = 2)))
    }

    @Test
    fun anythingElseTakesTheDefaultDelays() {
        assertEquals(0L, delay(IllegalStateException("decoder"), Facts(errorCount = 1)))
        assertEquals(1_000L, delay(IllegalStateException("decoder"), Facts(errorCount = 2)))
        assertEquals(5_000L, delay(IllegalStateException("decoder"), Facts(errorCount = 7)))
    }
}
