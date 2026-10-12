package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.net.Family
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
    fun prefetchAfterTenSecondsOrInTheLastMinute() {
        val min3 = 180_000L
        assertEquals(10_000L, PrefetchPolicy.delayMs(0L, min3))
        assertEquals(0L, PrefetchPolicy.delayMs(10_000L, min3))
        assertEquals(4_000L, PrefetchPolicy.delayMs(6_000L, -1L)) // duration unknown
        // A 65s track: the last-minute window opens at 5s, before the 10s mark.
        assertEquals(5_000L, PrefetchPolicy.delayMs(0L, 65_000L))
        assertEquals(0L, PrefetchPolicy.delayMs(5_000L, 40_000L)) // shorter than a minute
        // A quick skip (under 10 s in) still costs no request.
        assertEquals(true, PrefetchPolicy.delayMs(3_000L, min3) > 0L)
    }

    /** A fake extraction of [ytId]: rungs of itags 251, 250, 249 (best first). */
    private fun rungs(ytId: String): List<ResolvedStream> {
        val bps = listOf(160_000, 70_000, 50_000)
        return listOf(251, 250, 249).map { itag ->
            ResolvedStream(ytId, "https://rr1---sn-x.googlevideo.com/videoplayback?expire=1999999999&itag=$itag", emptyMap(), "", 0L, itag, 0, bps)
        }
    }

    @Test
    fun everyRungOfAnExtractionIsCachedAndAShortLadderServesItsBottom() {
        val cache = StreamUrlCache(100)
        val r = rungs("v")
        cache.putExtraction("v", r[0], r, null)
        assertEquals(251, cache.get("v", 0, null, 0L)?.itag)
        assertEquals(250, cache.get("v", 1, null, 0L)?.itag)
        assertEquals(249, cache.get("v", 2, null, 0L)?.itag)
        // A rung past this video's ladder, and Low: its bottom one.
        assertEquals(249, cache.get("v", 5, null, 0L)?.itag)
        assertEquals(249, cache.get("v", QualityLadder.LOWEST, null, 0L)?.itag)
        assertNull(cache.get("w", 0, null, 0L))
        cache.removeVideo("v")
        assertNull(cache.get("v", 0, null, 0L))
    }

    @Test
    fun aKeptFormatWinsOverTheRungAfterAStep() {
        // Playing 251 (rung 1); Auto stepped down meanwhile; an outage resume loads it again
        // from byte 0 (not mid-stream): it must stay 251, not switch file mid-song.
        val cache = StreamUrlCache(100)
        val r = rungs("v")
        cache.putExtraction("v", r[0], r, null)
        assertEquals(250, cache.get("v", 1, null, 0L)?.itag) // what the new rung alone would give
        assertEquals(251, cache.get("v", 1, 251, 0L)?.itag)
        // The kept format isn't cached any more: nothing, so the resolver extracts it again.
        val other = StreamUrlCache(100)
        other.putExtraction("v", r[1], listOf(null, r[1], r[2]), null)
        assertNull(other.get("v", 1, 251, 0L))
        assertEquals(250, other.get("v", 1, 250, 0L)?.itag)
    }

    @Test
    fun aFallbackStreamServesEveryRung() {
        val cache = StreamUrlCache(100)
        val muxed = ResolvedStream("v", "https://rr1---sn-x.googlevideo.com/videoplayback?expire=1999999999&itag=18", emptyMap(), "", 0L, 18)
        cache.putExtraction("v", muxed, emptyList(), muxed)
        assertEquals(18, cache.get("v", 0, null, 0L)?.itag)
        assertEquals(18, cache.get("v", 3, null, 0L)?.itag)
    }

    @Test
    fun cachedUrlsCanBeDroppedByWhatTheyAreBoundTo() {
        val lru = TtlLru<String, String>(10)
        val v4 = "https://x.googlevideo.com/videoplayback?ip=203.0.113.9&itag=251"
        val v6 = "https://x.googlevideo.com/videoplayback?ip=2001%3Adb8%3A%3A1&itag=251"
        val none = "https://x.googlevideo.com/videoplayback?itag=251"
        lru.put("a", v4, 100)
        lru.put("b", v6, 100)
        lru.put("c", none, 100)
        assertEquals(Family.IPV4, StreamUrls.familyOf(v4))
        assertEquals(Family.IPV6, StreamUrls.familyOf(v6))
        assertNull(StreamUrls.familyOf(none))
        // A new IPv6 address: only the IPv6-bound URL goes; the others still work.
        lru.removeValuesIf { StreamUrls.familyOf(it) == Family.IPV6 }
        assertNull(lru.get("b", 0))
        assertEquals(v4, lru.get("a", 0))
        assertEquals(none, lru.get("c", 0))
        assertEquals(2, lru.size())
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
