package io.github.iamandelib.cyberjuke.yt

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.exceptions.SignInConfirmNotBotException
import java.io.IOException

/**
 * The lean stream resolver offline: a fake downloader answers the visionOS visitor id and
 * player request with a recorded-shape response, and counts what else the extractor asks for.
 */
class LeanResolverTest {
    private val sent = ArrayList<String>()
    private var player: (String) -> String = { playerResponse(it) }

    private val fake = object : Downloader() {
        override fun execute(request: Request): Response {
            val url = request.url()
            // What DownloaderImpl does first: the lean filter.
            LeanRequests.answer(url, request.dataToSend())?.let { return it }
            sent.add(endpoint(url))
            val body = when {
                url.contains("/visitor_id") -> VISITOR
                url.contains("/player") -> player(VIDEO)
                // The WEB client version, fetched once per process (static in the extractor).
                url.endsWith("/sw.js") -> "self.x={\"INNERTUBE_CONTEXT_CLIENT_VERSION\":\"2.20260805.01.00\"}"
                else -> throw IOException("offline: $url")
            }
            return Response(200, "OK", mapOf("Content-Type" to listOf("application/json")), body, url)
        }
    }

    private fun endpoint(url: String) = url.substringBefore('?').substringAfterLast('/')

    @Before
    fun setUp() {
        YtCompat.ensureInit() // so later calls don't replace the fake
        NewPipe.init(fake)
    }

    @After
    fun tearDown() {
        NewPipe.init(DownloaderImpl.get())
        YtCompat.lean = true
    }

    @Test
    fun twoRequestsGiveTheStreams() {
        val ex = YtCompat.extractLean(VIDEO)
        assertEquals(listOf("visitor_id", "player"), sent.filter { it == "visitor_id" || it == "player" })
        assertTrue("only the visionOS requests go out: $sent", sent.none { it == "next" })
        assertEquals(listOf(140, 251), ex.audio.map { it.itag }.sorted())
        val opus = ex.audio.first { it.itag == 251 }
        assertEquals(135_000, opus.bitrate)
        assertTrue(opus.url.startsWith("https://rr1---sn-test.googlevideo.com/videoplayback?"))
        assertEquals(213L, ex.durationSec)
    }

    @Test
    fun theWebAndNextRequestsAreAnsweredLocally() {
        val web = """{"context":{"client":{"clientName":"WEB","clientVersion":"2.2025"}}}""".toByteArray()
        val vision = """{"context":{"client":{"clientName":"VISIONOS","clientVersion":"0.1"}}}""".toByteArray()
        val remix = """{"context":{"client":{"clientName":"WEB_REMIX"}}}""".toByteArray()
        val v1 = "https://www.youtube.com/youtubei/v1"
        assertEquals(LeanRequests.Skip.REFUSE, LeanRequests.classify("$v1/visitor_id?prettyPrint=false", web))
        assertEquals(LeanRequests.Skip.NONE, LeanRequests.classify("$v1/visitor_id?prettyPrint=false", vision))
        assertEquals(LeanRequests.Skip.NONE, LeanRequests.classify("$v1/visitor_id?prettyPrint=false", remix))
        assertEquals(
            LeanRequests.Skip.REFUSE,
            LeanRequests.classify("$v1/player?prettyPrint=false&\$fields=microformat,videoDetails.videoId", null),
        )
        assertEquals(LeanRequests.Skip.NONE, LeanRequests.classify("https://youtubei.googleapis.com/youtubei/v1/player?id=x", vision))
        assertEquals(LeanRequests.Skip.EMPTY_JSON, LeanRequests.classify("$v1/next?prettyPrint=false", web))
        assertEquals(LeanRequests.Skip.NONE, LeanRequests.classify("https://evil.example/youtubei/v1/next", web))
        // Only while the lean resolver runs on this thread.
        assertNull(LeanRequests.answer("$v1/next?prettyPrint=false", web))
    }

    @Test
    fun aBotCheckIsYouTubesAnswerNotAReasonToFallBack() {
        player = { BOT_CHECK }
        try {
            YtCompat.extract(VIDEO)
            fail("expected the bot check")
        } catch (e: SignInConfirmNotBotException) {
        }
        assertEquals(1, sent.count { it == "player" }) // no second, full extraction
    }

    @Test
    fun anythingUnexpectedFallsBackToTheFullExtraction() {
        player = { playerResponse(it, formats = "[]") }
        try {
            YtCompat.extract(VIDEO)
            fail("the fake has no streams for the full path either")
        } catch (e: Exception) {
        }
        assertTrue(YtCompat.lastLeanFallback!!.contains("no streams"))
        // The full path ran, with all its requests: visionOS and WEB player, and next.
        assertEquals(3, sent.count { it == "player" })
        assertTrue(sent.contains("next"))
    }

    companion object {
        const val VIDEO = "dQw4w9WgXcQ"

        private const val VISITOR =
            """{"responseContext":{"visitorData":"CgtUZXN0VmlzaXRvchIA","serviceTrackingParams":[]}}"""

        private const val BOT_CHECK =
            """{"responseContext":{},"playabilityStatus":{"status":"LOGIN_REQUIRED",""" +
                """"reason":"Sign in to confirm you're not a bot","messages":["This helps protect our community."]}}"""

        private fun format(itag: Int, mime: String, bitrate: Int) =
            """{"itag":$itag,"url":"https://rr1---sn-test.googlevideo.com/videoplayback?expire=1999999999&itag=$itag""" +
                """&ip=203.0.113.9&mime=audio%2Fx","mimeType":"$mime","bitrate":$bitrate,"averageBitrate":$bitrate,""" +
                """"contentLength":"3500000","approxDurationMs":"213000","audioQuality":"AUDIO_QUALITY_MEDIUM",""" +
                """"audioSampleRate":"48000","audioChannels":2,"lastModified":"1","quality":"tiny"}"""

        fun playerResponse(
            id: String,
            formats: String = "[" + format(140, "audio/mp4; codecs=\\\"mp4a.40.2\\\"", 130_000) + "," +
                format(251, "audio/webm; codecs=\\\"opus\\\"", 135_000) + "]",
        ) = """{"responseContext":{},"playabilityStatus":{"status":"OK"},""" +
            """"streamingData":{"expiresInSeconds":"21540","formats":[],"adaptiveFormats":$formats},""" +
            """"videoDetails":{"videoId":"$id","title":"Test","lengthSeconds":"213","isLive":false,""" +
            """"author":"Test","channelId":"UC0000000000000000000000","thumbnail":{"thumbnails":[]}}}"""
    }
}
