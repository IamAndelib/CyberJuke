package io.github.iamandelib.cyberjuke.yt

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MusicTextTest {

    @Test
    fun channelIdFromUrls() {
        val id = "UCiMhD4jzUqG-IgPzUmmytRQ"
        assertEquals(id, MusicText.channelIdOf("https://www.youtube.com/channel/$id"))
        assertEquals(id, MusicText.channelIdOf("https://music.youtube.com/channel/$id?si=abc"))
        assertEquals(id, MusicText.channelIdOf("https://www.youtube.com/channel/$id/videos"))
        assertNull(MusicText.channelIdOf("https://www.youtube.com/@queenofficial"))
        assertNull(MusicText.channelIdOf("https://www.youtube.com/user/queen"))
        assertNull(MusicText.channelIdOf("https://www.youtube.com/playlist?list=PL123"))
        assertNull(MusicText.channelIdOf(null))
        assertNull(MusicText.channelIdOf(""))
    }

    @Test
    fun artistsFromLinkedRuns() {
        val runs = JSONArray(
            """
            [{"text":"Bill Withers","navigationEndpoint":{"browseEndpoint":{"browseId":"UCDjpW6k2Sfg_FTr1toLvffQ"}}},
             {"text":" & "},
             {"text":"Grover Washington, Jr.","navigationEndpoint":{"browseEndpoint":{"browseId":"UCsN1HTruhFfXcSMGMsBmX_w"}}},
             {"text":", "},{"text":"Unlinked Guest"},{"text":" • "},
             {"text":"Winelight","navigationEndpoint":{"browseEndpoint":{"browseId":"MPREb_abcdefghijk"}}},
             {"text":"Bill Withers","navigationEndpoint":{"browseEndpoint":{"browseId":"UCDjpW6k2Sfg_FTr1toLvffQ"}}}]
            """,
        )
        assertEquals(
            listOf(YtMusic.Credit("Bill Withers", "UCDjpW6k2Sfg_FTr1toLvffQ"), YtMusic.Credit("Grover Washington, Jr.", "UCsN1HTruhFfXcSMGMsBmX_w")),
            MusicText.artistsOf(runs),
        )
        assertTrue(MusicText.artistsOf(null).isEmpty())
    }

    @Test
    fun theUploaderIsTheOneCredit() {
        assertEquals(
            listOf(YtMusic.Credit("Queen", "UCiMhD4jzUqG-IgPzUmmytRQ")),
            MusicText.creditOf("Queen - Topic", "https://music.youtube.com/channel/UCiMhD4jzUqG-IgPzUmmytRQ"),
        )
        assertTrue(MusicText.creditOf("Queen", "https://www.youtube.com/@queenofficial").isEmpty())
        assertTrue(MusicText.creditOf(null, "https://music.youtube.com/channel/UCiMhD4jzUqG-IgPzUmmytRQ").isEmpty())
    }

    @Test
    fun creditsFromTheBridgeAreChecked() {
        val ok = YtMusic.Credit("Grover Washington, Jr.", "UCsN1HTruhFfXcSMGMsBmX_w")
        assertEquals(listOf(ok), MusicText.creditsOf(MusicText.creditsJson(listOf(ok))))
        val odd = JSONArray(
            """
            [{"name":"","channelId":"UCsN1HTruhFfXcSMGMsBmX_w"},{"name":"No id"},{"name":"Bad","channelId":"PL123"},
             {"name":7,"channelId":"UCsN1HTruhFfXcSMGMsBmX_w"},"text",null,
             {"name":"Grover Washington, Jr.","channelId":"UCsN1HTruhFfXcSMGMsBmX_w"}]
            """,
        )
        assertEquals(listOf(ok), MusicText.creditsOf(odd))
        val many = JSONArray((1..15).map { org.json.JSONObject().put("name", "A$it").put("channelId", "UCsN1HTruhFfXcSMGMsBmX_w") })
        assertEquals(MusicText.MAX_CREDITS, MusicText.creditsOf(many).size)
        assertTrue(MusicText.creditsOf(null).isEmpty())
    }

    @Test
    fun creditsMatchExactlyNotBySubstring() {
        assertTrue(MusicText.creditsOverlap("Queen", "Queen"))
        assertTrue(MusicText.creditsOverlap("Queen", "Queen & David Bowie"))
        assertTrue(MusicText.creditsOverlap("Daft Punk", "Daft Punk feat. Pharrell Williams"))
        assertTrue(MusicText.creditsOverlap("Beyoncé", "BEYONCE"))
        assertTrue(MusicText.creditsOverlap("Simon & Garfunkel", "Simon & Garfunkel"))
        assertFalse(MusicText.creditsOverlap("Queen", "Ivy Queen"))
        assertFalse(MusicText.creditsOverlap("Queen", "Queen Butterfly"))
        assertFalse(MusicText.creditsOverlap("", "Queen"))
        assertTrue(MusicText.creditsOverlap("宇多田ヒカル", "宇多田ヒカル"))
    }
}
