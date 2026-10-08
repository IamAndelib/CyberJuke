package io.github.iamandelib.cyberjuke.player

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
