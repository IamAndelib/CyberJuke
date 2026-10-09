package io.github.iamandelib.cyberjuke.playback

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BridgeLimitsTest {
    private fun track(i: Int, title: String = "t$i") =
        JSONObject().put("id", "id$i").put("ytId", "fJ9rUzIMcZQ").put("title", title).put("artist", "x")

    @Test
    fun trackCountIsCappedAt2000() {
        BridgeLimits.checkTracks(JSONArray((0 until 2000).map { track(it) }))
        assertThrows(TooLargeException::class.java) {
            BridgeLimits.checkTracks(JSONArray((0 until 2001).map { track(it) }))
        }
    }

    @Test
    fun everyStringIsCappedAt2000Characters() {
        BridgeLimits.checkTracks(JSONArray().put(track(0, "x".repeat(2000))))
        assertThrows(TooLargeException::class.java) {
            BridgeLimits.checkTracks(JSONArray().put(track(0, "x".repeat(2001))))
        }
        // Any key, also ones the parser does not read.
        assertThrows(TooLargeException::class.java) {
            BridgeLimits.checkTracks(JSONArray().put(track(0).put("postUrl", "y".repeat(5000))))
        }
        assertThrows(TooLargeException::class.java) { BridgeLimits.checkString("z".repeat(2001), "label") }
        assertEquals(null, BridgeLimits.checkString(null, "label"))
    }

    @Test
    fun idArraysAreCappedAndMustBeStrings() {
        assertEquals(listOf("a", "b"), BridgeLimits.idsOf(JSONArray().put("a").put("b")))
        assertThrows(TooLargeException::class.java) { BridgeLimits.idsOf(JSONArray((0..2000).map { "id$it" })) }
        assertThrows(TooLargeException::class.java) { BridgeLimits.idsOf(JSONArray().put("q".repeat(2001))) }
        assertThrows(IllegalArgumentException::class.java) { BridgeLimits.idsOf(JSONArray().put(3)) }
    }
}
