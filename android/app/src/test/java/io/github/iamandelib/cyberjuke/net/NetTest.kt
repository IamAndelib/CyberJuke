package io.github.iamandelib.cyberjuke.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.After
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

    @After
    fun tearDown() = NetPrefs.resetForTest()

    @Test
    fun ipv4ModesAndThePerNetworkAutoMemory() {
        var now = 0L
        NetPrefs.clock = { now }
        val changes = ArrayList<Boolean>()
        NetPrefs.onChange = { changes.add(it) }
        NetPrefs.onNetwork("wifi")
        assertFalse(NetPrefs.preferIpv4) // Auto starts on the system's pick
        assertTrue(NetPrefs.canSwitchToIpv4())
        assertTrue(NetPrefs.switchToIpv4Automatically())
        assertTrue(NetPrefs.preferIpv4)
        assertFalse(NetPrefs.canSwitchToIpv4())
        assertFalse(NetPrefs.switchToIpv4Automatically()) // once
        assertEquals(listOf(true), changes)
        // Mobile data is remembered separately; back on Wi-Fi, IPv4 again.
        assertTrue(NetPrefs.onNetwork("cellular"))
        assertFalse(NetPrefs.preferIpv4)
        assertTrue(NetPrefs.onNetwork("wifi"))
        assertTrue(NetPrefs.preferIpv4)
        // A day later the memory has lapsed (on the next network change, never mid-track).
        now = NetPrefs.AUTO_MS + 1
        assertTrue(NetPrefs.preferIpv4)
        NetPrefs.onNetwork("cellular")
        NetPrefs.onNetwork("wifi")
        assertFalse(NetPrefs.preferIpv4)
        assertEquals(emptyMap<String, Long>(), NetPrefs.memory())
    }

    @Test
    fun alwaysAndOffOverrideTheAutoMemory() {
        NetPrefs.clock = { 0L }
        NetPrefs.onNetwork("wifi")
        NetPrefs.switchToIpv4Automatically()
        assertTrue(NetPrefs.setMode(Ipv4Mode.OFF))
        assertFalse(NetPrefs.preferIpv4)
        assertFalse(NetPrefs.canSwitchToIpv4())
        assertTrue(NetPrefs.setMode(Ipv4Mode.ALWAYS))
        assertTrue(NetPrefs.preferIpv4)
        assertFalse(NetPrefs.setMode(Ipv4Mode.AUTO)) // Auto remembered IPv4 here: no change
        assertTrue(NetPrefs.preferIpv4)
    }

    @Test
    fun theAutoMemorySurvivesARestart() {
        NetPrefs.clock = { 0L }
        NetPrefs.onNetwork("cellular")
        NetPrefs.switchToIpv4Automatically()
        val saved = NetPrefs.encodeMemory(NetPrefs.memory())
        assertEquals("cellular=${NetPrefs.AUTO_MS}", saved)
        NetPrefs.resetForTest()
        NetPrefs.clock = { 1L }
        NetPrefs.onNetwork("cellular")
        assertTrue(NetPrefs.load(Ipv4Mode.AUTO, NetPrefs.decodeMemory(saved)))
        assertTrue(NetPrefs.preferIpv4)
        assertEquals(mapOf("a" to 1L), NetPrefs.decodeMemory("a=1;=2;b=x;c d=3;;"))
        assertEquals(emptyMap<String, Long>(), NetPrefs.decodeMemory(null))
    }

    @Test
    fun limitPolicy() {
        assertEquals(LimitPolicy.Action.SWITCH_TO_IPV4, LimitPolicy.decide(viaIpv6 = true, canSwitchToIpv4 = true, retried = false))
        assertEquals(LimitPolicy.Action.SWITCH_TO_IPV4, LimitPolicy.decide(viaIpv6 = true, canSwitchToIpv4 = true, retried = true))
        assertEquals(LimitPolicy.Action.RETRY_LATER, LimitPolicy.decide(viaIpv6 = true, canSwitchToIpv4 = false, retried = false))
        assertEquals(LimitPolicy.Action.RETRY_LATER, LimitPolicy.decide(viaIpv6 = false, canSwitchToIpv4 = true, retried = false))
        assertEquals(LimitPolicy.Action.BLOCK, LimitPolicy.decide(viaIpv6 = false, canSwitchToIpv4 = true, retried = true))
    }

    @Test
    fun familyOfAnAddress() {
        assertEquals(Family.IPV4, Families.familyOf(v4))
        assertEquals(Family.IPV6, Families.familyOf(v6))
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

    @Test
    fun mediaUrlsMustBeHttpsOnYouTubeMediaHosts() {
        assertTrue(Hosts.isAllowedMediaUrl("https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1&itag=251"))
        assertTrue(Hosts.isAllowedMediaUrl("https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1/file/index.m3u8"))
        assertFalse(Hosts.isAllowedMediaUrl("http://rr3---sn-abc.googlevideo.com/videoplayback?itag=251"))
        assertFalse(Hosts.isAllowedMediaUrl("https://evil.example/videoplayback"))
        assertFalse(Hosts.isAllowedMediaUrl("file:///data/data/x"))
        assertFalse(Hosts.isAllowedMediaUrl("content://media/1"))
        assertFalse(Hosts.isAllowedMediaUrl("asset:///ci-tone.ogg"))
    }
}
