package io.github.iamandelib.cyberjuke.player

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.AssumptionViolatedException
import org.junit.Before
import org.junit.Test

/**
 * Daily YouTube canary (Y8, .github/workflows/canary.yml): runs the app's own YouTube code
 * (YtCompat, YtMusic, InnerTube, DownloaderImpl, Lyrics.lrclib) on a plain JVM against the live
 * services, so a NewPipeExtractor break shows up before users report it.
 *
 * - A parse failure, or an answer that parses into nothing, FAILS (YouTube changed something).
 * - A bot check, rate limit or network failure is inconclusive: a JUnit assumption skip.
 * - Skipped entirely unless the `canary` system property is "true"
 *   (`./gradlew testDebugUnitTest -Pcanary=true --tests '*YouTubeCanaryTest*'`).
 *
 * Nothing here may touch Android classes (android.jar is stubs-only in unit tests).
 */
class YouTubeCanaryTest {

    @Before
    fun enabled() {
        assumeTrue("YouTube canary not requested (-Pcanary=true)", System.getProperty("canary") == "true")
    }

    /** Runs [block]; bot checks and network failures become skips, parse failures failures. */
    private fun <T> live(what: String, block: () -> T): T = try {
        block()
    } catch (e: AssertionError) {
        throw e
    } catch (e: AssumptionViolatedException) {
        throw e
    } catch (t: Throwable) {
        when (YtCompat.classify(t)) {
            FailureKind.BOT_CHECK, FailureKind.RATE_LIMIT ->
                throw AssumptionViolatedException("INCONCLUSIVE $what: ${YtCompat.describe(t)}")
            FailureKind.NETWORK ->
                throw AssumptionViolatedException("INCONCLUSIVE $what (network): ${YtCompat.describe(t)}")
            else -> throw AssertionError("BROKEN $what: ${YtCompat.describe(t)}", t)
        }
    }

    @Test
    fun resolvesFixedVideos() {
        for ((id, title) in VIDEOS) {
            val ex = live("resolve $id ($title)") { YtCompat.extract(id) }
            val streams = ex.audio + ex.muxed
            assertTrue("$id: no progressive stream and no manifest", streams.isNotEmpty() || ex.hlsUrl != null)
            assertTrue("$id: no audio-only stream", ex.audio.isNotEmpty())
            assertTrue("$id: duration ${ex.durationSec}", ex.durationSec > 60)
            for (s in streams) {
                assertTrue("$id: stream host ${Hosts.hostOf(s.url)}", Hosts.isYouTubeMedia(Hosts.hostOf(s.url)))
                assertTrue("$id: itag ${s.itag}", s.itag > 0)
            }
            assertTrue("$id: no expire= in the stream URL", ex.audio.all { StreamUrls.expireMs(it.url) != null })
        }
    }

    /** The first bytes of a resolved stream, requested the way PlaybackService does. */
    @Test
    fun streamsTheFirstBytes() {
        val (id, title) = VIDEOS.first()
        val ex = live("resolve $id ($title)") { YtCompat.extract(id) }
        val s = ex.audio.maxByOrNull { it.bitrate } ?: throw AssertionError("$id: no audio stream")
        val request = Request.Builder()
            .url(s.url + "&range=0-4095&rn=1")
            .apply { YtCompat.streamHeaders(s.url).forEach { (k, v) -> header(k, v) } }
            .post(StreamResolver.POST_BODY.toRequestBody("application/octet-stream".toMediaType()))
            .build()
        live("stream $id") {
            Http.client.newCall(request).execute().use { r ->
                if (r.code == 403 || r.code == 429) {
                    throw AssumptionViolatedException(
                        "INCONCLUSIVE stream $id: HTTP ${r.code} (IP block or stream-token enforcement)",
                    )
                }
                assertEquals("stream $id HTTP status", 200, r.code)
                @Suppress("UNNECESSARY_SAFE_CALL", "USELESS_ELVIS")
                val n = r.body?.bytes()?.size ?: 0
                assertTrue("stream $id: $n bytes", n > 0)
            }
        }
    }

    /**
     * YouTube Music only has its song catalog in some countries: elsewhere a search offers no
     * "Songs" filter and artist pages show only videos and podcasts. That is the runner's
     * location, not a break, so it is inconclusive.
     */
    private fun assumeMusicCatalog() {
        val json = live("music catalog check") {
            InnerTube.post("search", JSONObject().put("query", "Queen Bohemian Rhapsody"))
                ?: throw AssertionError("music search: HTTP 404")
        }
        val chips = Regex(""""chipCloudChipRenderer".{0,400}?"text"\s*:\s*"([^"]+)"""")
            .findAll(json.toString()).map { it.groupValues[1] }.toList()
        if (chips.isNotEmpty() && "Songs" !in chips) {
            throw AssumptionViolatedException(
                "INCONCLUSIVE: YouTube Music offers no song catalog from this IP's region (filters: $chips)",
            )
        }
    }

    @Test
    fun musicSearch() {
        assumeMusicCatalog()
        val r = live("music search") { YtMusic.search("Queen Bohemian Rhapsody", YtMusic.Filter.SONGS) }
        val songs = r.items.filter { it.kind == "song" && SessionPolicy.isValidYtId(it.ytId) }
        assertTrue("music search: ${r.items.size} items, ${songs.size} songs with an id", songs.size >= 3)
        assertTrue("music search: no song by Queen", songs.any { it.subtitle.contains("Queen", ignoreCase = true) })
    }

    @Test
    fun artistPage() {
        assumeMusicCatalog()
        val a = live("artist page $QUEEN") { YtMusic.artistPage(QUEEN) }
        assertTrue("artist page name '${a.name}'", a.name.contains("Queen", ignoreCase = true))
        assertTrue("artist page: no top songs (source ${a.source})", a.topSongs.isNotEmpty())
        assertTrue("artist page: no releases (source ${a.source})", a.releases.isNotEmpty())
        assertTrue("artist page: top songs without ids", a.topSongs.all { SessionPolicy.isValidYtId(it.ytId) })
    }

    /**
     * The song radio (AP3) and its continuation. A layout change fails (ParsingException ->
     * BROKEN); a blocked or empty radio (no catalog from this region) is inconclusive.
     */
    @Test
    fun radio() {
        val (id, _) = VIDEOS.first()
        val first = live("radio $id") { YtMusic.radio(id) }
        if (first.items.isEmpty()) throw AssumptionViolatedException("INCONCLUSIVE radio $id: empty from this IP's region")
        assertTrue("radio $id: items without an id or title", first.items.all { SessionPolicy.isValidYtId(it.ytId) && it.title.isNotBlank() })
        assertTrue("radio $id: the seed is listed", first.items.none { it.ytId == id })
        val next = first.next ?: throw AssertionError("radio $id: no continuation")
        val more = live("radio $id page 2") { YtMusic.radio(id, next) }
        assumeTrue("INCONCLUSIVE radio $id page 2: empty", more.items.isNotEmpty())
        assertTrue("radio $id page 2: items without an id", more.items.all { SessionPolicy.isValidYtId(it.ytId) })
    }

    @Test
    fun lyricsLookup() {
        val r = live("LRCLIB lyrics") { Lyrics.lrclib("Bohemian Rhapsody", "Queen", null, 354.0) }
        assertTrue("LRCLIB: Bohemian Rhapsody not found", r != null && r.found)
        assertTrue("LRCLIB: no synced lines", (r?.synced?.size ?: 0) > 10)
    }

    private companion object {
        /** Stable official uploads (label/artist channels), available worldwide. */
        val VIDEOS = listOf(
            "fJ9rUzIMcZQ" to "Queen - Bohemian Rhapsody",
            "dQw4w9WgXcQ" to "Rick Astley - Never Gonna Give You Up",
            "kJQP7kiw5Fk" to "Luis Fonsi - Despacito ft. Daddy Yankee",
        )
        const val QUEEN = "UCEPMVbUzImPl4p8k4LkGevA"
    }
}
