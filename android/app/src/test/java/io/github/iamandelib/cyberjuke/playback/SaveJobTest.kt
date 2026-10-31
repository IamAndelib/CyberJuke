package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.net.FailureKind
import io.github.iamandelib.cyberjuke.playback.LikedSaver.SaveJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException

/** The liked saver's job: what each way a save can go becomes ([SaveOutcome]), the world faked through [SaveJob.Deps]. */
class SaveJobTest {
    private val id = "dQw4w9WgXcQ"
    private val mp3Id = "mp3:IZq8cMcx.mp3"
    private val mb = 1024L * 1024L
    private val audio = ResolvedStream(id, "https://r1.googlevideo.com/videoplayback", emptyMap(), "opus", 0L, itag = 251, audioOnly = true)
    private val muxed = audio.copy(itag = 18, audioOnly = false)

    /** A refusal the writer reports (the production one: an HTTP status). */
    /** The writer's request answered [code] (what Media3's InvalidResponseCodeException carries). */
    private class Http(val code: Int) : IOException("$code")

    /** The world as a test sets it up; every call is recorded. */
    private inner class World(
        var quiet: Boolean = false,
        var denied: Boolean = false,
        var whole: Boolean = false,
        var wholeAfterWrite: Boolean = true,
        var resolve: () -> ResolvedStream = { audio },
        var hasCache: Boolean = true,
        var write: (SaveJob) -> Unit = {},
        var limit: Long = 256 * mb,
        /** What the writer reports before the bytes are written: (length, -1 unknown; cached so far). */
        var reports: List<Pair<Long, Long>> = emptyList(),
        /** What it reports once the last byte came (a length learned only at the end), with no stop after. */
        var endReport: Pair<Long, Long>? = null,
        /** The key of a whole copy in the listening cache. */
        var listening: String? = null,
    ) : SaveJob.Deps {
        val calls = ArrayList<String>()
        var job: SaveJob? = null
        var cancelledWriter = false
        /** writer() throws this instead of giving a writer. */
        var noWriter: IOException? = null
        private var written = false
        val discarded = ArrayList<String>()

        override fun quiet() = quiet

        override fun limitBytes() = limit

        override fun discard(audioId: String) {
            discarded.add(audioId)
        }

        override fun isDenied(audioId: String) = denied.also { calls.add("denied") }

        override fun isWhole(audioId: String): Boolean {
            calls.add("whole")
            return if (written) wholeAfterWrite else whole
        }

        override fun resolve(ytId: String): ResolvedStream {
            calls.add("resolve")
            return resolve.invoke()
        }

        override fun writer(ytId: String, stream: ResolvedStream, progress: SaveJob.Progress): SaveJob.Writer? {
            calls.add("writer")
            return newWriter(progress)
        }

        override fun mp3Writer(audioId: String, progress: SaveJob.Progress): SaveJob.Writer? {
            calls.add("mp3Writer")
            return newWriter(progress)
        }

        override fun listeningCopy(audioId: String) = listening

        override fun copyWriter(audioId: String, key: String, progress: SaveJob.Progress): SaveJob.Writer? {
            calls.add("copy $key")
            return newWriter(progress)
        }

        private fun newWriter(progress: SaveJob.Progress): SaveJob.Writer? {
            noWriter?.let { throw it }
            if (!hasCache) return null
            return object : SaveJob.Writer {
                override fun cache() {
                    calls.add("cache")
                    // As CacheWriter: a cancel shows at the next check, as an InterruptedIOException.
                    for ((length, cached) in reports) {
                        progress.onProgress(length, cached)
                        if (cancelledWriter) throw InterruptedIOException()
                    }
                    write(job!!)
                    calls.add("bytes")
                    endReport?.let { (length, cached) -> progress.onProgress(length, cached) }
                    written = true
                }

                override fun cancel() {
                    cancelledWriter = true
                }
            }
        }

        val forgotten = ArrayList<String>()

        override fun httpCode(e: IOException) = (e as? Http)?.code

        override fun forgetLink(ytId: String) {
            forgotten.add(ytId)
        }

        fun run(audioId: String = id): SaveOutcome {
            val j = SaveJob(audioId, this)
            job = j
            return j.run()
        }
    }

    private fun resolveFails(kind: FailureKind): () -> ResolvedStream = { throw ResolveException(id, kind.name, null, kind) }

    @Test
    fun aSongSavedWholeIsSavedWithoutAnExtraction() {
        val w = World(whole = true)
        assertEquals(SaveOutcome.SAVED, w.run())
        assertFalse("resolve" in w.calls)
    }

    @Test
    fun theWholeSaveIsAnExtractionThenTheBytesThenTheCheck() {
        val w = World()
        assertEquals(SaveOutcome.SAVED, w.run())
        assertEquals(listOf("denied", "whole", "resolve", "writer", "cache", "bytes", "whole"), w.calls)
    }

    @Test
    fun aBackOffASignOutOrACancelBeforeTheStartIsNoFaultOfTheSong() {
        assertEquals(SaveOutcome.CANCELLED, World(quiet = true).run())
        assertEquals(SaveOutcome.CANCELLED, World(denied = true).run())
        val w = World()
        val j = SaveJob(id, deps = w)
        j.cancel()
        assertEquals(SaveOutcome.CANCELLED, j.run())
        assertTrue(w.calls.isEmpty())
    }

    @Test
    fun aListeningCopyIsCopiedWithNoExtraction() {
        val key = "yt:$id:250:3000"
        // In a back-off too: it asks nothing of YouTube.
        val w = World(listening = key, quiet = true)
        assertEquals(SaveOutcome.SAVED, w.run())
        assertEquals(listOf("denied", "whole", "copy $key", "cache", "bytes", "whole"), w.calls)
        // A byte the listening copy lost: a strike, as any stopped save.
        assertEquals(SaveOutcome.STOPPED, World(listening = key, write = { throw IOException("missing") }).run())
        // Already in the saved store: nothing copied.
        val done = World(listening = key, whole = true)
        assertEquals(SaveOutcome.SAVED, done.run())
        assertFalse(done.calls.any { it.startsWith("copy") })
    }

    @Test
    fun theExtractionsFailuresSortTheSong() {
        // This video can't be played: given up for the service's life.
        assertEquals(SaveOutcome.FAILED, World(resolve = resolveFails(FailureKind.CONTENT)).run())
        assertEquals(SaveOutcome.FAILED, World(resolve = resolveFails(FailureKind.OTHER)).run())
        assertEquals(SaveOutcome.FAILED, World(resolve = { throw ManifestOnlyException(id, "https://m/x.m3u8", "application/x-mpegURL") }).run())
        // The network: a strike, tried again later.
        assertEquals(SaveOutcome.STOPPED, World(resolve = resolveFails(FailureKind.NETWORK)).run())
        assertEquals(SaveOutcome.STOPPED, World(resolve = { throw SocketTimeoutException("read") }).run())
        // YouTube pushing back, or the extractor broken: wait, no strike.
        assertEquals(SaveOutcome.CANCELLED, World(resolve = resolveFails(FailureKind.BOT_CHECK)).run())
        assertEquals(SaveOutcome.CANCELLED, World(resolve = resolveFails(FailureKind.RATE_LIMIT)).run())
        assertEquals(SaveOutcome.CANCELLED, World(resolve = resolveFails(FailureKind.BROKEN)).run())
        // A connection that failed because a back-off began meanwhile isn't a strike either.
        val quietNow = World()
        quietNow.resolve = {
            quietNow.quiet = true
            throw IOException("reset")
        }
        assertEquals(SaveOutcome.CANCELLED, quietNow.run())
    }

    @Test
    fun onlyAnAudioOnlyFormatIsKept() {
        val w = World(resolve = { muxed })
        assertEquals(SaveOutcome.FAILED, w.run())
        assertFalse("writer" in w.calls)
        assertEquals(SaveOutcome.FAILED, World(resolve = { audio.copy(itag = 0) }).run())
    }

    @Test
    fun withoutACacheTheSaveStopsForNow() {
        assertEquals(SaveOutcome.STOPPED, World(hasCache = false).run())
    }

    @Test
    fun theWriteDecidesTheRest() {
        // Written, but a span playback had locked was read past: not whole yet, a strike.
        assertEquals(SaveOutcome.STOPPED, World(wholeAfterWrite = false).run())
        // Gone: given up.
        assertEquals(SaveOutcome.FAILED, World(write = { throw Http(404) }).run())
        // The link refused (expired, or a new address): a strike, and the next try extracts afresh.
        for (code in listOf(403, 410)) {
            val stale = World(write = { throw Http(code) })
            assertEquals("$code", SaveOutcome.STOPPED, stale.run())
            assertEquals("$code", listOf(id), stale.forgotten)
        }
        // YouTube failing: a strike, the link kept.
        val failing = World(write = { throw Http(503) })
        assertEquals(SaveOutcome.STOPPED, failing.run())
        assertTrue(failing.forgotten.isEmpty())
        // The connection broke: a strike.
        assertEquals(SaveOutcome.STOPPED, World(write = { throw IOException("reset") }).run())
        // The request couldn't even be built (no link): a strike.
        val noLink = World()
        noLink.noWriter = IOException("no link")
        assertEquals(SaveOutcome.STOPPED, noLink.run())
        // A back-off began while writing: no strike.
        val quietNow = World()
        quietNow.write = {
            quietNow.quiet = true
            throw IOException("reset")
        }
        assertEquals(SaveOutcome.CANCELLED, quietNow.run())
    }

    @Test
    fun aCancelMidWayStopsTheWriterAndCountsForNothing() {
        // Cancelled from another thread while the bytes come: the writer is told, the outcome is CANCELLED.
        val w = World(write = { j ->
            j.cancel()
            throw IOException("cancelled")
        })
        assertEquals(SaveOutcome.CANCELLED, w.run())
        assertTrue(w.cancelledWriter)
        // Cancelled during the extraction: nothing is written.
        val during = World()
        during.resolve = {
            during.job!!.cancel()
            audio
        }
        assertEquals(SaveOutcome.CANCELLED, during.run())
        assertFalse("writer" in during.calls)
        // Cancelled during a failing extraction: no strike for the song.
        val failing = World()
        failing.resolve = {
            failing.job!!.cancel()
            throw ResolveException(id, "network", null, FailureKind.NETWORK)
        }
        assertEquals(SaveOutcome.CANCELLED, failing.run())
    }

    @Test
    fun aJukeboxMp3IsSavedWithNoExtraction() {
        // Its file straight from latex.gg, through the same writer and the same check.
        val w = World(resolve = { throw AssertionError("an MP3 is never extracted") })
        assertEquals(SaveOutcome.SAVED, w.run(audioId = mp3Id))
        assertEquals(listOf("denied", "whole", "mp3Writer", "cache", "bytes", "whole"), w.calls)
        // Already whole: nothing fetched.
        val whole = World(whole = true)
        assertEquals(SaveOutcome.SAVED, whole.run(audioId = mp3Id))
        assertFalse("mp3Writer" in whole.calls)
    }

    @Test
    fun aYouTubeBackOffDoesNotHoldAJukeboxMp3() {
        // A back-off holds a video's save (no extraction), not an MP3's: latex.gg isn't YouTube.
        assertEquals(SaveOutcome.CANCELLED, World(quiet = true).run())
        assertEquals(SaveOutcome.SAVED, World(quiet = true).run(audioId = mp3Id))
        // So a connection lost while one runs is a strike, back-off or not, as for any failure.
        assertEquals(SaveOutcome.STOPPED, World(quiet = true, write = { throw IOException("reset") }).run(audioId = mp3Id))
    }

    @Test
    fun aJukeboxMp3sSaveFailsAndStopsAsAVideosDoes() {
        // Members-only while signed out, or cancelled: no fault of the song.
        assertEquals(SaveOutcome.CANCELLED, World(denied = true).run(audioId = mp3Id))
        // No cache, a write that isn't whole yet, a dropped connection: strikes.
        assertEquals(SaveOutcome.STOPPED, World(hasCache = false).run(audioId = mp3Id))
        assertEquals(SaveOutcome.STOPPED, World(wholeAfterWrite = false).run(audioId = mp3Id))
        assertEquals(SaveOutcome.STOPPED, World(write = { throw IOException("reset") }).run(audioId = mp3Id))
        // Refused: given up.
        assertEquals(SaveOutcome.FAILED, World(write = { throw Http(403) }).run(audioId = mp3Id))
        // latex.gg failing or rate limiting: tried again later, as for a video.
        for (code in listOf(503, 429)) {
            assertEquals("$code", SaveOutcome.STOPPED, World(write = { throw Http(code) }).run(audioId = mp3Id))
            assertEquals("$code", SaveOutcome.STOPPED, World(write = { throw Http(code) }).run())
        }
        // Cancelled mid-way: the writer is told.
        val w = World(write = { j ->
            j.cancel()
            throw IOException("cancelled")
        })
        assertEquals(SaveOutcome.CANCELLED, w.run(audioId = mp3Id))
        assertTrue(w.cancelledWriter)
    }

    @Test
    fun aSongTooBigForTheCacheIsGivenUpOnBeforeItsBytesCome() {
        // A 150 MB mix (or a long video) in a 128 MB cache: its length, told when the request
        // opens, is over what the cache leaves beside listening. Stopped before a byte is read,
        // given up on, and whatever of it was in the cache goes.
        for (audioId in listOf(mp3Id, id)) {
            val w = World(limit = 128 * mb, reports = listOf(150 * mb to 0L))
            assertEquals(audioId, SaveOutcome.FAILED, w.run(audioId = audioId))
            assertTrue(w.cancelledWriter)
            assertFalse("bytes" in w.calls)
            assertEquals(listOf(audioId), w.discarded)
        }
        // Up to the limit less the listening reserve, it fits.
        val reserve = LikedSaverPolicy.LISTENING_RESERVE_BYTES
        assertEquals(SaveOutcome.SAVED, World(limit = 128 * mb, reports = listOf(128 * mb - reserve to 0L)).run(audioId = mp3Id))
        assertEquals(SaveOutcome.FAILED, World(limit = 128 * mb, reports = listOf(128 * mb - reserve + 1 to 0L)).run(audioId = mp3Id))
        // A bigger cache takes it.
        assertEquals(SaveOutcome.SAVED, World(limit = 512 * mb, reports = listOf(150 * mb to 0L)).run(audioId = mp3Id))
    }

    @Test
    fun withNoLengthTheSaveStopsOnceTheBytesAreTooMany() {
        // latex.gg sent no Content-Length: the bytes so far count, and the save stops at the cap.
        val w = World(limit = 128 * mb, reports = listOf(-1L to 50 * mb, -1L to 97 * mb, -1L to 120 * mb))
        assertEquals(SaveOutcome.FAILED, w.run(audioId = mp3Id))
        assertTrue(w.cancelledWriter)
        assertEquals(listOf(mp3Id), w.discarded)
        // A length learned only with the last byte (no stop comes after it) still counts.
        val atEnd = World(limit = 128 * mb, endReport = 100 * mb to 100 * mb)
        assertEquals(SaveOutcome.FAILED, atEnd.run(audioId = mp3Id))
        assertEquals(listOf(mp3Id), atEnd.discarded)
    }
}
