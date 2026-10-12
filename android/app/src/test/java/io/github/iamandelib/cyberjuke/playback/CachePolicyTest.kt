package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.playback.LikedSaverPolicy.Facts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CachePolicyTest {
    private val mb = 1024L * 1024L

    // ---- keys and the "saved whole" check ----

    @Test
    fun keysNameTheVideoAndTheFormat() {
        assertEquals("yt:dQw4w9WgXcQ:251", CacheKeys.of("dQw4w9WgXcQ", 251))
        assertEquals("dQw4w9WgXcQ", CacheKeys.ytIdOf("yt:dQw4w9WgXcQ:251"))
        assertEquals(251, CacheKeys.itagOf("yt:dQw4w9WgXcQ:251"))
        // Ids may contain '-' and '_' (never ':').
        assertEquals("a-b_c-d_e-f", CacheKeys.ytIdOf(CacheKeys.of("a-b_c-d_e-f", 140)))
        assertTrue(CacheKeys.isYt("yt:dQw4w9WgXcQ:140"))
        // Anything else bypasses the cache: no key, a URL, an asset, a broken key.
        for (k in listOf(null, "https://x.googlevideo.com/videoplayback?itag=251", "asset:///ci-tone.ogg", "yt:", "yt:abc", "yt::251", "yt:abc:0", "yt:abc:x")) {
            assertFalse(k.toString(), CacheKeys.isYt(k))
        }
    }

    @Test
    fun wholeOnlyWithAKnownLengthAndEveryByteThere() {
        assertTrue(CacheKeys.isWhole(4_000_000L) { it == 4_000_000L })
        assertFalse(CacheKeys.isWhole(4_000_000L) { false })
        // Length unknown (the response never said, or nothing was written yet): not whole.
        var asked = false
        assertFalse(CacheKeys.isWhole(-1L) { asked = true; true })
        assertFalse(asked)
        assertFalse(CacheKeys.isWhole(0L) { true })
    }

    @Test
    fun aResumeStaysInItsFormatOtherwiseTheRungsThenAny() {
        // A resume (or a track kept through an outage) only in its own file.
        assertEquals(140, CacheKeys.pick(listOf(251, 140), keep = 140, rungItag = 251))
        assertNull(CacheKeys.pick(listOf(251), keep = 140, rungItag = 251))
        // Otherwise the setting's rung when it's whole, else whatever is (most recent first).
        assertEquals(251, CacheKeys.pick(listOf(140, 251), keep = null, rungItag = 251))
        assertEquals(140, CacheKeys.pick(listOf(140, 250), keep = null, rungItag = 251))
        assertEquals(140, CacheKeys.pick(listOf(140), keep = null, rungItag = null))
        assertNull(CacheKeys.pick(emptyList(), keep = null, rungItag = 251))
    }

    // ---- the evictor's ledger ----

    @Test
    fun listeningEntriesGoFirstLeastRecentlyUsedFirst() {
        val l = CacheLedger(20 * mb)
        l.setLiked(listOf("liked00000a"), known = false)
        l.onAdded(CacheKeys.of("liked00000a", 251), 5 * mb, touched = 1)
        l.onAdded(CacheKeys.of("listen0000a", 251), 5 * mb, touched = 2)
        l.onAdded(CacheKeys.of("listen0000b", 251), 5 * mb, touched = 3)
        assertEquals(15 * mb, l.total)
        assertEquals(5 * mb, l.likedBytes)
        assertEquals(emptyList<String>(), l.victims())
        // 15 MB more: the two listening entries go, oldest first; the liked one, older still, stays.
        assertEquals(listOf(CacheKeys.of("listen0000a", 251), CacheKeys.of("listen0000b", 251)), l.victims(15 * mb))
        // Played again: it's the newest now.
        l.onTouched(CacheKeys.of("listen0000a", 251), touched = 9)
        assertEquals(listOf(CacheKeys.of("listen0000b", 251)), l.victims(10 * mb))
        // Never the key being written.
        assertEquals(listOf(CacheKeys.of("listen0000a", 251)), l.victims(10 * mb, protect = CacheKeys.of("listen0000b", 251)))
    }

    @Test
    fun likedOnlyWhenLikedAloneAreOverTheLimitLeastRecentlyLikedFirst() {
        val l = CacheLedger(12 * mb)
        // Newest like first: c was liked last, a first.
        l.setLiked(listOf("likedc00000", "likedb00000", "likeda00000"), known = false)
        l.onAdded(CacheKeys.of("likedc00000", 251), 4 * mb, touched = 1)
        l.onAdded(CacheKeys.of("likeda00000", 251), 4 * mb, touched = 5)
        l.onAdded(CacheKeys.of("likedb00000", 251), 4 * mb, touched = 3)
        l.onAdded(CacheKeys.of("listen0000a", 251), 2 * mb, touched = 9)
        // Over by 2 MB: the listening entry, however recent.
        assertEquals(listOf(CacheKeys.of("listen0000a", 251)), l.victims())
        // Over by 6 MB: then the least recently liked (a), whatever its last use.
        assertEquals(listOf(CacheKeys.of("listen0000a", 251), CacheKeys.of("likeda00000", 251)), l.victims(4 * mb))
    }

    @Test
    fun aSmallerLimitEvictsAtOnce() {
        val l = CacheLedger(512 * mb)
        l.setLiked(listOf("likeda00000"), known = false)
        l.onAdded(CacheKeys.of("likeda00000", 251), 100 * mb, touched = 1)
        repeat(3) { l.onAdded(CacheKeys.of("listen0000$it", 251), 60 * mb, touched = 2L + it) }
        assertEquals(emptyList<String>(), l.victims())
        l.limit = 128 * mb
        // 280 MB in a 128 MB cache: every listening entry (152 MB over), the liked one stays.
        assertEquals((0..2).map { CacheKeys.of("listen0000$it", 251) }, l.victims())
        for (k in l.victims()) l.onRemoved(k, l.bytesOf(k))
        assertEquals(100 * mb, l.total)
        assertEquals(emptyList<String>(), l.victims())
    }

    @Test
    fun unlikingMakesAnOrdinaryListeningEntry() {
        val l = CacheLedger(10 * mb)
        l.setLiked(listOf("likeda00000", "likedb00000"), known = false)
        l.onAdded(CacheKeys.of("likeda00000", 251), 4 * mb, touched = 1)
        l.onAdded(CacheKeys.of("likedb00000", 251), 4 * mb, touched = 2)
        l.onAdded(CacheKeys.of("listen0000a", 251), 4 * mb, touched = 3)
        assertEquals(listOf(CacheKeys.of("listen0000a", 251)), l.victims())
        l.setLiked(listOf("likedb00000"))
        assertEquals(4 * mb, l.likedBytes)
        // a is listening now, and the least recently used.
        assertEquals(listOf(CacheKeys.of("likeda00000", 251)), l.victims())
        assertFalse(l.isLiked("likeda00000"))
    }

    @Test
    fun likesSinceTheLastListAreFresh() {
        val l = CacheLedger(10 * mb)
        // Nothing to compare with: none is fresh (a backlog is not "liked just now").
        assertEquals(emptyList<String>(), l.setLiked(listOf("a0000000000", "b0000000000"), known = false))
        assertEquals(listOf("c0000000000"), l.setLiked(listOf("c0000000000", "a0000000000", "b0000000000")))
        assertEquals(emptyList<String>(), l.setLiked(listOf("a0000000000")))
        assertEquals(listOf("a0000000000"), l.liked)
    }

    @Test
    fun spansAddUpPerKeyAndTheLastOneTakesTheKeyAway() {
        val l = CacheLedger(100 * mb)
        val k = CacheKeys.of("listen0000a", 251)
        l.onAdded(k, 5 * mb, touched = 1)
        l.onAdded(k, 2 * mb, touched = 4)
        l.onAdded(CacheKeys.of("listen0000a", 140), 1 * mb, touched = 2)
        assertEquals(7 * mb, l.bytesOf(k))
        // Most recently used first.
        assertEquals(listOf(k, CacheKeys.of("listen0000a", 140)), l.keysOf("listen0000a"))
        l.onRemoved(k, 5 * mb)
        assertEquals(2 * mb, l.bytesOf(k))
        l.onRemoved(k, 2 * mb)
        assertEquals(listOf(CacheKeys.of("listen0000a", 140)), l.keysOf("listen0000a"))
        assertEquals(1 * mb, l.total)
        // A key it never saw changes nothing.
        l.onRemoved("yt:unknown0000:251", 3 * mb)
        l.onTouched("yt:unknown0000:251", 9)
        assertEquals(1 * mb, l.total)
    }

    @Test
    fun likedFullLeavesRoomForListening() {
        val l = CacheLedger(128 * mb)
        l.setLiked(listOf("likeda00000"), known = false)
        l.onAdded(CacheKeys.of("likeda00000", 251), 90 * mb, touched = 1)
        assertFalse(l.likedFull(LikedSaverPolicy.LISTENING_RESERVE_BYTES))
        l.onAdded(CacheKeys.of("likeda00000", 140), 10 * mb, touched = 2)
        assertTrue(l.likedFull(LikedSaverPolicy.LISTENING_RESERVE_BYTES))
    }

    // ---- the liked saver ----

    private val liked = listOf("new00000000", "mid00000000", "old00000000")

    @Test
    fun backfillNewestLikeFirstOnWifiOnly() {
        assertEquals("new00000000", LikedSaverPolicy.next(Facts(liked, saved = emptySet())))
        assertEquals("mid00000000", LikedSaverPolicy.next(Facts(liked, saved = setOf("new00000000"))))
        // Mobile data: no backlog.
        assertNull(LikedSaverPolicy.next(Facts(liked, saved = emptySet(), unmetered = false)))
        // All saved: nothing to do.
        assertNull(LikedSaverPolicy.next(Facts(liked, saved = liked.toSet())))
    }

    @Test
    fun aSongLikedJustNowIsSavedOnAnyNetworkAtOnce() {
        val f = Facts(liked, saved = emptySet(), fresh = setOf("mid00000000"), unmetered = false, sinceLastMs = 1_000L, likedFull = true)
        assertEquals("mid00000000", LikedSaverPolicy.next(f))
        assertTrue(LikedSaverPolicy.keepGoing(f, fresh = true))
        assertFalse(LikedSaverPolicy.keepGoing(f, fresh = false))
    }

    @Test
    fun nothingWhileOfflineQuietLoadingBusyOrFull() {
        val base = Facts(liked, saved = emptySet(), fresh = setOf("new00000000"))
        for (f in listOf(base.copy(online = false), base.copy(quiet = true), base.copy(playerLoading = true), base.copy(busy = true))) {
            assertNull(f.toString(), LikedSaverPolicy.next(f))
        }
        // Full of liked songs: the backlog waits (a fresh like still goes).
        assertNull(LikedSaverPolicy.next(Facts(liked, saved = emptySet(), likedFull = true)))
    }

    @Test
    fun backfillExtractionsAreSpacedOut() {
        assertNull(LikedSaverPolicy.next(Facts(liked, saved = emptySet(), sinceLastMs = LikedSaverPolicy.MIN_GAP_MS - 1)))
        assertEquals("new00000000", LikedSaverPolicy.next(Facts(liked, saved = emptySet(), sinceLastMs = LikedSaverPolicy.MIN_GAP_MS)))
    }

    @Test
    fun neverWhatThePlayerLoadsAnywayNorAFailure() {
        assertEquals("old00000000", LikedSaverPolicy.next(Facts(liked, saved = emptySet(), skip = setOf("new00000000", "mid00000000"))))
    }

    @Test
    fun aRunningSaveGivesWay() {
        val f = Facts(liked, saved = emptySet())
        assertTrue(LikedSaverPolicy.keepGoing(f, fresh = false))
        // The current track starts loading (a rebuffer, a skip, a new list): playback comes first.
        assertFalse(LikedSaverPolicy.keepGoing(f.copy(playerLoading = true), fresh = true))
        // A back-off, the connection gone, or Wi-Fi left for mobile data during a backfill.
        assertFalse(LikedSaverPolicy.keepGoing(f.copy(quiet = true), fresh = true))
        assertFalse(LikedSaverPolicy.keepGoing(f.copy(online = false), fresh = true))
        assertFalse(LikedSaverPolicy.keepGoing(f.copy(unmetered = false), fresh = false))
    }
}
