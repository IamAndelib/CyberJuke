package io.github.iamandelib.cyberjuke.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress

class NetTest {
    private val v4 = InetAddress.getByAddress("h", byteArrayOf(142.toByte(), 250.toByte(), 1, 1))
    private val v6 = InetAddress.getByAddress("h", ByteArray(16).also { it[0] = 0x2a; it[15] = 1 })

    @Test
    fun preferIpv4KeepsOnlyIpv4WhenThereIsAny() {
        assertEquals(listOf(v6, v4), NetPrefs.order(listOf(v6, v4), preferIpv4 = false))
        assertEquals(listOf(v4), NetPrefs.order(listOf(v6, v4), preferIpv4 = true))
        assertEquals(listOf(v6), NetPrefs.order(listOf(v6), preferIpv4 = true)) // IPv6-only host
    }

    @Test
    fun exactHostChecks() {
        assertTrue(Hosts.isYouTube("www.youtube.com"))
        assertTrue(Hosts.isYouTube("music.youtube.com"))
        assertTrue(Hosts.isYouTube("youtube.com"))
        assertFalse(Hosts.isYouTube("youtube.com.evil.example"))
        assertFalse(Hosts.isYouTube("notyoutube.com"))
        assertFalse(Hosts.isYouTube("lrclib.net"))
        assertFalse(Hosts.isYouTube(Hosts.hostOf("https://lrclib.net/api/get?track_name=youtube.com")))
        assertTrue(Hosts.isYouTubeMedia("rr3---sn-abc.googlevideo.com"))
        assertFalse(Hosts.isYouTubeMedia("googlevideo.com.evil.example"))
        assertFalse(Hosts.isYouTubeMedia(null))
    }
}
