package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.net.FailureKind
import io.github.iamandelib.cyberjuke.playback.LikedSaver.SaveJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException

/** The liked saver's job: what each way a save can go becomes ([SaveOutcome]), the world faked through [SaveJob.Deps]. */
class SaveJobTest {
    private val id = "dQw4w9WgXcQ"
    private val audio = ResolvedStream(id, "https://r1.googlevideo.com/videoplayback", emptyMap(), "opus", 0L, itag = 251, audioOnly = true)
    private val muxed = audio.copy(itag = 18, audioOnly = false)

    /** A refusal the writer reports (the production one: an HTTP status). */
    private class Refused : IOException("403")

    /** The world as a test sets it up; every call is recorded. */
    private inner class World(
        var quiet: Boolean = false,
        var denied: Boolean = false,
        var whole: Boolean = false,
        var wholeAfterWrite: Boolean = true,
        var resolve: () -> ResolvedStream = { audio },
        var hasCache: Boolean = true,
        var write: (SaveJob) -> Unit = {},
    ) : SaveJob.Deps {
        val calls = ArrayList<String>()
        var job: SaveJob? = null
        var cancelledWriter = false
        /** writer() throws this instead of giving a writer. */
        var noWriter: IOException? = null
        private var written = false

        override fun quiet() = quiet

        override fun isDenied(ytId: String) = denied.also { calls.add("denied") }

        override fun isWhole(ytId: String): Boolean {
            calls.add("whole")
            return if (written) wholeAfterWrite else whole
        }

        override fun resolve(ytId: String): ResolvedStream {
            calls.add("resolve")
            return resolve.invoke()
        }

        override fun writer(ytId: String, stream: ResolvedStream): SaveJob.Writer? {
            calls.add("writer")
            noWriter?.let { throw it }
            if (!hasCache) return null
            return object : SaveJob.Writer {
                override fun cache() {
                    calls.add("cache")
                    write(job!!)
                    written = true
                }

                override fun cancel() {
                    cancelledWriter = true
                }
            }
        }

        override fun refused(e: IOException) = e is Refused

        fun run(fresh: Boolean = true): SaveOutcome {
            val j = SaveJob(id, fresh, this)
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
        assertEquals(listOf("denied", "whole", "resolve", "writer", "cache", "whole"), w.calls)
    }

    @Test
    fun aBackOffASignOutOrACancelBeforeTheStartIsNoFaultOfTheSong() {
        assertEquals(SaveOutcome.CANCELLED, World(quiet = true).run())
        assertEquals(SaveOutcome.CANCELLED, World(denied = true).run())
        val w = World()
        val j = SaveJob(id, fresh = true, deps = w)
        j.cancel()
        assertEquals(SaveOutcome.CANCELLED, j.run())
        assertTrue(w.calls.isEmpty())
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
        // Refused (an expired link, a block): given up.
        assertEquals(SaveOutcome.FAILED, World(write = { throw Refused() }).run())
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
}
