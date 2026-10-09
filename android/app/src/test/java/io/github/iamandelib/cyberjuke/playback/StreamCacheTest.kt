package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class StreamCacheTest {
    private val url = "https://rr1---sn-abc.googlevideo.com/videoplayback?expire=1760000000&ei=x&itag=251&source=youtube&mime=audio%2Fwebm"

    @Test
    fun expiryComesFromTheUrl() {
        assertEquals(1_760_000_000_000L, StreamUrls.expireMs(url))
        assertEquals(251, StreamUrls.itag(url))
        assertEquals(1_760_000_000_000L - 30 * 60_000L, StreamUrls.cacheUntil(url, 0L))
        // Path-style parameters (manifests)
        val path = "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1760000123/ei/x/itag/140/file/index.m3u8"
        assertEquals(1_760_000_123_000L, StreamUrls.expireMs(path))
        assertEquals(140, StreamUrls.itag(path))
        // Not fooled by other parameters ending in "expire"
        assertNull(StreamUrls.expireMs("https://x.googlevideo.com/videoplayback?noexpire=1760000000"))
    }

    @Test
    fun withoutExpireTheCacheKeepsOneHour() {
        val plain = "https://example.com/a.m4a"
        assertNull(StreamUrls.expireMs(plain))
        assertEquals(1_000L + 3_600_000L, StreamUrls.cacheUntil(plain, 1_000L))
    }

    @Test
    fun expiredOnlyOnceGooglevideoSaysSo() {
        val expire = 1_760_000_000_000L
        assertFalse(StreamUrls.isExpired(url, 0L, expire - 1))
        assertTrue(StreamUrls.isExpired(url, 0L, expire))
    }

    @Test
    fun lruEvictsTheLeastRecentlyUsedAndHonoursDeadlines() {
        val lru = TtlLru<String, Int>(3)
        lru.put("a", 1, 100)
        lru.put("b", 2, 100)
        lru.put("c", 3, 100)
        assertEquals(1, lru.get("a", 0)) // a is now most recent
        lru.put("d", 4, 100) // evicts b, not a
        assertNull(lru.get("b", 0))
        assertEquals(1, lru.get("a", 0))
        assertEquals(3, lru.size())
        assertNull(lru.get("c", 100)) // deadline passed
        assertEquals(2, lru.size())
        lru.removeIf { it.startsWith("a") }
        assertNull(lru.get("a", 0))
    }

    @Test
    fun hundredEntriesNeverClearEverything() {
        val lru = TtlLru<Int, Int>(100)
        for (i in 0 until 250) lru.put(i, i, Long.MAX_VALUE)
        assertEquals(100, lru.size())
        assertEquals(249, lru.get(249, 0))
        assertNull(lru.get(149, 0))
        assertEquals(150, lru.get(150, 0))
    }

    @Test
    fun onlyTheLatestPrefetchRuns() {
        val pool = Executors.newSingleThreadExecutor()
        try {
            val runner = LatestTaskRunner(pool)
            val gate = CountDownLatch(1)
            val ran = Collections.synchronizedList(ArrayList<String>())
            // Occupy the thread so the next submissions queue up.
            runner.submit("busy") { gate.await(5, TimeUnit.SECONDS); ran.add("busy") }
            Thread.sleep(50)
            runner.submit("a") { ran.add("a") }
            runner.submit("b") { ran.add("b") } // cancels a (not started)
            assertFalse(runner.submit("b") { ran.add("b2") }) // same key pending: no-op
            assertEquals("b", runner.pendingKey())
            gate.countDown()
            pool.submit {}.get(5, TimeUnit.SECONDS)
            assertEquals(listOf("busy", "b"), ran)
            runner.cancel()
            assertNull(runner.pendingKey())
        } finally {
            pool.shutdownNow()
        }
    }

    @Test
    fun rnOnlyOnQueryStyleVideoplaybackUrls() {
        assertTrue(YtUrls.wantsRn("https://rr1---sn-abc.googlevideo.com/videoplayback?expire=1760000000&itag=251"))
        // Path-style HLS segment: appending "&rn=" would corrupt the path (M3).
        assertFalse(YtUrls.wantsRn("https://rr1---sn-abc.googlevideo.com/videoplayback/id/x.1/itag/140/expire/1760000000/sq/3/file/seg.ts"))
        assertFalse(YtUrls.wantsRn("https://rr1---sn-abc.googlevideo.com/videoplayback?itag=251&rn=4"))
        assertFalse(YtUrls.wantsRn("https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1/file/index.m3u8"))
        assertFalse(YtUrls.wantsRn("https://rr1---sn-abc.googlevideo.com/other/videoplayback?itag=251"))
    }

    @Test
    fun prefetchAfterThirtySecondsOrInTheLastMinute() {
        val min3 = 180_000L
        assertEquals(30_000L, PrefetchPolicy.delayMs(0L, min3))
        assertEquals(0L, PrefetchPolicy.delayMs(30_000L, min3))
        assertEquals(10_000L, PrefetchPolicy.delayMs(20_000L, -1L)) // duration unknown
        // A 70s track: the last-minute window opens at 10s, before the 30s mark.
        assertEquals(10_000L, PrefetchPolicy.delayMs(0L, 70_000L))
        assertEquals(0L, PrefetchPolicy.delayMs(5_000L, 40_000L)) // shorter than a minute
    }

    @Test
    fun theAddressAUrlIsBoundTo() {
        val base = "https://rr1---sn-x.googlevideo.com/videoplayback?expire=1999999999&itag=251"
        assertEquals(false, StreamUrls.boundToIpv6("$base&ip=203.0.113.9&id=o-x"))
        assertEquals(true, StreamUrls.boundToIpv6("$base&ip=2a02%3A8108%3A1%3A%3A1&id=o-x"))
        assertEquals(true, StreamUrls.boundToIpv6("$base&ip=2a02:8108:1::1"))
        assertEquals(true, StreamUrls.boundToIpv6("https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1/ip/2001%3Adb8%3A%3A1/file/index.m3u8"))
        assertEquals(null, StreamUrls.boundToIpv6(base))
        assertEquals(null, StreamUrls.boundToIpv6("$base&sip=1.2.3.4")) // not the ip parameter
    }
}
