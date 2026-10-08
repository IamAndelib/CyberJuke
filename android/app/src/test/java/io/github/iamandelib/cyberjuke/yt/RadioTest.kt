package io.github.iamandelib.cyberjuke.yt

import io.github.iamandelib.cyberjuke.net.FailureKind
import io.github.iamandelib.cyberjuke.playback.SessionPolicy
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.schabi.newpipe.extractor.exceptions.ParsingException

/**
 * The radio parser (AP3) against responses captured from music.youtube.com on 2026-10-08
 * (`next` for RDAMVMfJ9rUzIMcZQ and its first continuation, trimmed to a few items). From the
 * capture's region YouTube Music offered videos rather than songs, so the bylines read
 * "Channel • views • likes"; the song shape ("Artist • Album • Year", wrapper renderers) is
 * covered by a small hand-written response in the documented layout.
 */
class RadioTest {

    private fun fixture(name: String) =
        JSONObject(javaClass.classLoader!!.getResource(name)!!.readText())

    @Test
    fun firstPage() {
        val page = Radio.parse(fixture("radio_next.json"), SEED)
        assertEquals("the seed itself is left out", 7, page.items.size)
        assertFalse(page.items.any { it.ytId == SEED })
        val first = page.items.first()
        assertEquals("kijpcUv-b8M", first.ytId)
        assertEquals("Queen - Somebody To Love (Official Video)", first.title)
        assertEquals("Queen Official", first.subtitle)
        assertEquals("song", first.kind)
        assertEquals(310L, first.durationSec)
        assertEquals("https://music.youtube.com/watch?v=kijpcUv-b8M", first.url)
        assertTrue(first.thumbnailUrl!!.startsWith("https://i.ytimg.com/vi/kijpcUv-b8M/"))
        assertEquals("UCiMhD4jzUqG-IgPzUmmytRQ", first.channelId)
        assertTrue(page.items.all { SessionPolicy.isValidYtId(it.ytId) && it.title.isNotBlank() && it.subtitle.isNotBlank() })
        assertTrue("continuation", page.next!!.startsWith("CDIS"))
    }

    @Test
    fun continuationPage() {
        val page = Radio.parse(fixture("radio_continuation.json"), SEED)
        assertEquals(6, page.items.size)
        assertEquals("LfmrHTdXgK4", page.items.first().ytId)
        assertEquals("Queen - Flash (Official Video)", page.items.first().title)
        assertEquals(173L, page.items.first().durationSec)
        assertTrue(page.next!!.isNotEmpty())
    }

    @Test
    fun songShapeAndWrappers() {
        val json = JSONObject(
            """
            {"continuationContents":{"playlistPanelContinuation":{"contents":[
              {"playlistPanelVideoWrapperRenderer":{"primaryRenderer":{"playlistPanelVideoRenderer":{
                "videoId":"AAAAAAAAAAA","title":{"runs":[{"text":"Under Pressure"}]},
                "longBylineText":{"runs":[
                  {"text":"Queen","navigationEndpoint":{"browseEndpoint":{"browseId":"UCEPMVbUzImPl4p8k4LkGevA"}}},
                  {"text":" & "},{"text":"David Bowie"},{"text":" • "},{"text":"Hot Space"},{"text":" • "},{"text":"1982"}]},
                "lengthText":{"runs":[{"text":"4:08"}]},
                "thumbnail":{"thumbnails":[{"url":"https://lh3.googleusercontent.com/a=w60-h60","height":60},
                  {"url":"https://lh3.googleusercontent.com/a=w544-h544","height":544},
                  {"url":"https://lh3.googleusercontent.com/a=w300-h300","height":300}]}}}}},
              {"playlistPanelVideoRenderer":{"navigationEndpoint":{"watchEndpoint":{"videoId":"BBBBBBBBBBB"}},
                "title":{"runs":[{"text":"Bicycle Race"}]},"shortBylineText":{"runs":[{"text":"Queen - Topic"}]}}},
              {"playlistPanelVideoRenderer":{"videoId":"AAAAAAAAAAA","title":{"runs":[{"text":"Duplicate"}]}}},
              {"playlistPanelVideoRenderer":{"videoId":"bad","title":{"runs":[{"text":"Bad id"}]}}},
              {"automixPreviewVideoRenderer":{}}
            ],"continuations":[{"nextContinuationData":{"continuation":"TOKEN2"}}]}}}
            """,
        )
        val page = Radio.parse(json, null)
        assertEquals(listOf("AAAAAAAAAAA", "BBBBBBBBBBB"), page.items.map { it.ytId })
        val a = page.items[0]
        assertEquals("Queen & David Bowie", a.subtitle)
        assertEquals("UCEPMVbUzImPl4p8k4LkGevA", a.channelId)
        assertEquals(248L, a.durationSec)
        assertEquals("https://lh3.googleusercontent.com/a=w300-h300", a.thumbnailUrl)
        assertEquals("Queen", Radio.cleanCredit(page.items[1].subtitle))
        assertNull(page.items[1].durationSec)
        assertEquals("TOKEN2", page.next)
    }

    @Test
    fun endOfRadioAndEmpty() {
        val page = Radio.parse(JSONObject("""{"contents":{"x":{"playlistPanelRenderer":{"contents":[]}}}}"""), SEED)
        assertTrue(page.items.isEmpty())
        assertNull(page.next)
    }

    @Test
    fun aChangedLayoutIsAParseError() {
        try {
            Radio.parse(JSONObject("""{"contents":{"somethingNew":{}}}"""), SEED)
            fail("expected a ParsingException")
        } catch (e: ParsingException) {
            assertEquals(FailureKind.BROKEN, YtCompat.classify(e))
        }
    }

    @Test
    fun payloads() {
        val first = Radio.payload(SEED, null)
        assertEquals(SEED, first.getString("videoId"))
        assertEquals("RDAMVM$SEED", first.getString("playlistId"))
        val more = Radio.payload(SEED, "TOK")
        assertEquals("TOK", more.getString("continuation"))
        assertFalse(more.has("playlistId"))
    }

    private companion object {
        const val SEED = "fJ9rUzIMcZQ"
    }
}
