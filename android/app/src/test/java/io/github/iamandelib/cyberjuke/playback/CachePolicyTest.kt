package io.github.iamandelib.cyberjuke.playback

import androidx.media3.datasource.DataSpec
import io.github.iamandelib.cyberjuke.net.FailureKind
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
    fun aJukeboxMp3IsKeptByItsFileNameAndGoesThroughTheCache() {
        val key = CacheKeys.ofMp3("IZq8cMcx.mp3")!!
        assertEquals("mp3:IZq8cMcx.mp3", key)
        // Its key is its audio id (as Liked, the saved set and the gate know it): no format, no length.
        assertEquals(SessionPolicy.mp3AudioId("IZq8cMcx.mp3"), key)
        assertEquals(key, CacheKeys.audioIdOf(key))
        assertTrue(CacheKeys.isMp3(key))
        assertTrue(CacheKeys.isCacheable(key))
        assertFalse(CacheKeys.isYt(key))
        assertNull(CacheKeys.ytIdOf(key))
        assertNull(CacheKeys.itagOf(key))
        // A video's key still names its video, and goes through the cache as before.
        assertEquals("dQw4w9WgXcQ", CacheKeys.audioIdOf(CacheKeys.of("dQw4w9WgXcQ", 251, 3_000_000L)))
        assertTrue(CacheKeys.isCacheable(CacheKeys.of("dQw4w9WgXcQ", 251)))
        // Nothing else does: not the link itself, nor a file name that isn't one.
        for (k in listOf(null, "mp3:", "mp3:x.ogg", "mp3:../x.mp3", "mp3:a/b.mp3", "https://latex.gg/share/IZq8cMcx.mp3", "IZq8cMcx.mp3", "asset:///ci-tone.ogg", "yt:abc")) {
            assertFalse(k.toString(), CacheKeys.isCacheable(k))
        }
        assertNull(CacheKeys.ofMp3("../x.mp3"))
        assertNull(CacheKeys.audioIdOf("mp3:x.ogg"))
    }

    @Test
    fun aWholeJukeboxMp3PlaysWhateverTheQualityOrAResumeAsks() {
        val key = CacheKeys.ofMp3("IZq8cMcx.mp3")!!
        // pickKey goes by format, and an MP3 has none: it would never play from the cache.
        assertNull(CacheKeys.pickKey(listOf(key), keepKey = null, rungItag = 251, wantedBps = 160_000))
        // Its one file plays, on High, on a resume, whatever was asked.
        assertEquals(key, CacheKeys.pickFor(key, listOf(key), keepKey = null, rungItag = 251, wantedBps = 160_000))
        assertEquals(key, CacheKeys.pickFor(key, listOf(key), keepKey = "yt:dQw4w9WgXcQ:251", rungItag = null, wantedBps = 0))
        assertNull(CacheKeys.pickFor(key, emptyList(), keepKey = null, rungItag = null, wantedBps = 0))
        // A video's copy is still pickKey's choice.
        val a = CacheKeys.of("dQw4w9WgXcQ", 251, 3_000_000L)
        assertNull(CacheKeys.pickFor("dQw4w9WgXcQ", listOf(a), keepKey = CacheKeys.of("dQw4w9WgXcQ", 140), rungItag = 251, wantedBps = 0))
        assertEquals(a, CacheKeys.pickFor("dQw4w9WgXcQ", listOf(a), keepKey = null, rungItag = 251, wantedBps = 0))
    }

    @Test
    fun aLikedJukeboxMp3IsKeptLikeALikedVideo() {
        val liked = CacheKeys.ofMp3("IZq8cMcx.mp3")!!
        val other = CacheKeys.ofMp3("FEHdI7AK.mp3")!!
        val l = CacheLedger(12 * mb)
        l.setLiked(listOf(liked, "likeda00000"), known = false)
        l.onAdded(liked, 3 * mb, touched = 1)
        l.onAdded(liked, 1 * mb, touched = 2)
        l.onAdded(CacheKeys.of("likeda00000", 251), 4 * mb, touched = 3)
        l.onAdded(other, 4 * mb, touched = 9)
        assertTrue(l.isLiked(liked))
        assertEquals(listOf(liked), l.keysOf(liked))
        assertEquals(8 * mb, l.likedBytes)
        // Over by 8 MB: the MP3 nobody liked first, however recent; then the least recently liked.
        assertEquals(listOf(other, CacheKeys.of("likeda00000", 251)), l.victims(8 * mb))
        // Unliked, it is an ordinary listening entry.
        l.setLiked(listOf("likeda00000"))
        assertFalse(l.isLiked(liked))
        assertEquals(listOf(liked, other), l.victims(8 * mb))
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
    fun onlyAFewNewLikesAreFreshABulkChangeIsBackfill() {
        val l = CacheLedger(10 * mb)
        l.setLiked(listOf("a0000000000"), known = true)
        // Three liked at once (a burst of hearts): still "just now".
        val three = listOf("d0000000000", "c0000000000", "b0000000000")
        assertEquals(three, l.setLiked(three + "a0000000000"))
        // Four or more at once (a sign-in bringing back likes, a restore): the backfill's.
        val more = listOf("h0000000000", "g0000000000", "f0000000000", "e0000000000")
        assertEquals(emptyList<String>(), l.setLiked(more + three + "a0000000000"))
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
    fun aFailedStartIsForgottenSoTheNextCountIsTheOnlyOne() {
        val l = CacheLedger(20 * mb)
        l.setLiked(listOf("liked00000a"), known = false)
        // What a start does: every span on disk counted in.
        val count = {
            l.onAdded(CacheKeys.of("liked00000a", 251), 8 * mb, touched = 1)
            l.onAdded(CacheKeys.of("listen0000a", 251), 8 * mb, touched = 2)
        }
        // Counted twice (a start that failed, then another): 32 MB of 16, and a real file would go.
        count()
        count()
        assertEquals(32 * mb, l.total)
        assertEquals(listOf(CacheKeys.of("listen0000a", 251)), l.victims())
        // Forgotten after the failed start: none of it is there to evict, nor saved.
        l.resetSpans()
        assertEquals(0L, l.total)
        assertEquals(0L, l.likedBytes)
        assertEquals(emptyList<String>(), l.keysOf("liked00000a"))
        assertFalse(l.likedFull(0L))
        count()
        assertEquals(16 * mb, l.total)
        assertEquals(8 * mb, l.likedBytes)
        assertEquals(emptyList<String>(), l.victims())
        // The liked list and the limit stay.
        assertTrue(l.isLiked("liked00000a"))
        assertEquals(listOf("liked00000a"), l.liked)
        assertEquals(20 * mb, l.limit)
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
        for (f in listOf(base.copy(online = false), base.copy(quiet = true), base.copy(playbackNeedsNetwork = true), base.copy(busy = true))) {
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
        assertFalse(LikedSaverPolicy.keepGoing(f.copy(playbackNeedsNetwork = true), fresh = true))
        // A back-off, the connection gone, or Wi-Fi left for mobile data during a backfill.
        assertFalse(LikedSaverPolicy.keepGoing(f.copy(quiet = true), fresh = true))
        assertFalse(LikedSaverPolicy.keepGoing(f.copy(online = false), fresh = true))
        assertFalse(LikedSaverPolicy.keepGoing(f.copy(unmetered = false), fresh = false))
    }

    @Test
    fun noSaveWithoutACacheToSaveInto() {
        // The cache failed to start: no extraction for nothing, fresh like or backfill, and no timer.
        val f = Facts(liked, saved = emptySet(), fresh = setOf("new00000000"), cache = false, retryInMs = 5_000L)
        assertNull(LikedSaverPolicy.next(f))
        assertNull(LikedSaverPolicy.next(f.copy(fresh = emptySet())))
        assertNull(LikedSaverPolicy.recheckInMs(f.copy(sinceLastMs = 10_000L)))
        assertFalse(LikedSaverPolicy.keepGoing(f, fresh = true))
        assertEquals("new00000000", LikedSaverPolicy.next(f.copy(cache = true)))
    }

    // ---- the review's fixes ----

    @Test
    fun aGatedLoadIsNotPlaybackNeedingTheNetwork() {
        // isLoading stays true while the track after next waits at the OpenGate: ignored.
        val ready = PlaybackNeed.Load(
            idle = false, buffering = false, positionMs = 10_000, durationMs = 200_000,
            bufferedPositionMs = 200_000, totalBufferedMs = 190_000 + 180_000, hasNext = true, nextDurationMs = 180_000,
            isLoading = true,
        )
        assertFalse(PlaybackNeed.needsNetwork(ready))
        // A stall, the current track not all there, or the next one not yet: playback first.
        assertTrue(PlaybackNeed.needsNetwork(ready.copy(buffering = true)))
        assertTrue(PlaybackNeed.needsNetwork(ready.copy(bufferedPositionMs = 120_000, totalBufferedMs = 110_000)))
        assertTrue(PlaybackNeed.needsNetwork(ready.copy(totalBufferedMs = 190_000 + 60_000)))
        assertTrue(PlaybackNeed.needsNetwork(ready.copy(nextDurationMs = -1)))
        assertTrue(PlaybackNeed.needsNetwork(ready.copy(durationMs = -1)))
        // No next track: the current one whole is enough.
        assertFalse(PlaybackNeed.needsNetwork(ready.copy(hasNext = false, totalBufferedMs = 190_000)))
        // Nothing prepared (a restored session before Play), or the list ended: nothing needed.
        assertFalse(PlaybackNeed.needsNetwork(ready.copy(idle = true, durationMs = -1, bufferedPositionMs = 0)))
        // The player stopped loading with the next track not all there (the buffer's size cap,
        // or a load error on it): nothing is coming over the network until it loads again.
        assertFalse(PlaybackNeed.needsNetwork(ready.copy(isLoading = false, totalBufferedMs = 190_000 + 60_000)))
        // The gap between the current track's load and the next one's: the next isn't prepared,
        // so playback is about to need the network even though nothing is loading this instant.
        assertTrue(PlaybackNeed.needsNetwork(ready.copy(isLoading = false, nextDurationMs = -1, totalBufferedMs = 190_000)))
        // A long track stopped by the buffer cap partway through: not that boundary, the saver may go.
        assertFalse(PlaybackNeed.needsNetwork(ready.copy(isLoading = false, nextDurationMs = -1, durationMs = 3_600_000, bufferedPositionMs = 600_000, totalBufferedMs = 590_000)))
        assertFalse(PlaybackNeed.needsNetwork(ready.copy(isLoading = false, bufferedPositionMs = 120_000, totalBufferedMs = 110_000)))
        // A stall always counts, loading or not.
        assertTrue(PlaybackNeed.needsNetwork(ready.copy(isLoading = false, buffering = true)))
    }

    @Test
    fun aFreshLikeSkipsTheGapOnlyOnItsFirstTry() {
        val f = Facts(liked, saved = emptySet(), fresh = setOf("mid00000000"), unmetered = false, sinceLastMs = 1_000L)
        assertEquals("mid00000000", LikedSaverPolicy.next(f))
        // Tried and not saved: again, but only after the gap (still on any network).
        val tried = f.copy(tried = setOf("mid00000000"))
        assertNull(LikedSaverPolicy.next(tried))
        assertEquals("mid00000000", LikedSaverPolicy.next(tried.copy(sinceLastMs = LikedSaverPolicy.MIN_GAP_MS)))
    }

    @Test
    fun theOneRecheckIsOnlyForWorkTheGapHoldsBack() {
        val f = Facts(liked, saved = emptySet(), sinceLastMs = 10_000L)
        assertEquals(LikedSaverPolicy.MIN_GAP_MS - 10_000L, LikedSaverPolicy.recheckInMs(f))
        // Nothing to do, or something else in the way (an event will come): no timer.
        assertNull(LikedSaverPolicy.recheckInMs(f.copy(saved = liked.toSet())))
        assertNull(LikedSaverPolicy.recheckInMs(f.copy(unmetered = false)))
        assertNull(LikedSaverPolicy.recheckInMs(f.copy(online = false)))
        assertNull(LikedSaverPolicy.recheckInMs(f.copy(playbackNeedsNetwork = true)))
        assertNull(LikedSaverPolicy.recheckInMs(f.copy(busy = true)))
        assertNull(LikedSaverPolicy.recheckInMs(f.copy(sinceLastMs = LikedSaverPolicy.MIN_GAP_MS)))
    }

    @Test
    fun aBackOffOrABrokenExtractorIsNoFaultOfTheSong() {
        // The song itself: given up on. The connection: a strike (SaveStrikes: waits, then gives up).
        assertEquals(SaveFailure.GIVE_UP, SaveFailure.of(FailureKind.CONTENT))
        assertEquals(SaveFailure.GIVE_UP, SaveFailure.of(FailureKind.OTHER))
        assertEquals(SaveFailure.STRIKE, SaveFailure.of(FailureKind.NETWORK))
        // YouTube backing off, or the extractor broken for every video: wait, no strike.
        for (k in listOf(FailureKind.BOT_CHECK, FailureKind.RATE_LIMIT, FailureKind.BROKEN)) {
            assertEquals(k.toString(), SaveFailure.WAIT, SaveFailure.of(k))
        }
    }

    @Test
    fun deniedSongsAreNeverPickedAndOnlyTheCandidateIsAsked() {
        val asked = ArrayList<String>()
        val f = Facts(liked, saved = setOf("new00000000"), denied = { asked.add(it); it == "mid00000000" })
        assertEquals("old00000000", LikedSaverPolicy.next(f))
        // Saved ones aren't asked about; the search stops at the first that may go.
        assertEquals(listOf("mid00000000", "old00000000"), asked)
    }

    @Test
    fun aResumeStaysInTheVeryFileItWasPlaying() {
        val a = CacheKeys.of("dQw4w9WgXcQ", 251, 3_000_000L)
        val b = CacheKeys.of("dQw4w9WgXcQ", 251, 3_100_000L)
        // The same format, another file: not swapped in mid-song.
        assertNull(CacheKeys.pickKey(listOf(b), keepKey = a, rungItag = 251, wantedBps = 0))
        assertEquals(a, CacheKeys.pickKey(listOf(b, a), keepKey = a, rungItag = 251, wantedBps = 0))
        // Not resuming: by format, as pick decides (most recent first).
        assertEquals(b, CacheKeys.pickKey(listOf(b, a), keepKey = null, rungItag = 251, wantedBps = 0))
        assertEquals(b, CacheKeys.pickKey(listOf(CacheKeys.of("dQw4w9WgXcQ", 140, 2_000_000L), b), keepKey = null, rungItag = 251, wantedBps = 160_000))
        assertNull(CacheKeys.pickKey(emptyList(), keepKey = null, rungItag = null, wantedBps = 0))
    }

    @Test
    fun aStoppedSaveWaitsLongerEachTimeAndTheFifthStopGivesUp() {
        val s = SaveStrikes()
        var now = 1_000_000L
        // 30 s, 1, 2, 4 min after the first four stops (Media3's DownloadManager retries a download
        // five times; the doubling is LoadRetry.delayMs's shape).
        for (wait in listOf(30_000L, 60_000L, 120_000L, 240_000L)) {
            assertFalse(s.stopped("a0000000000", now))
            assertEquals(setOf("a0000000000"), s.waiting(now))
            assertEquals(wait, s.nextDueInMs(now))
            assertEquals(setOf("a0000000000"), s.waiting(now + wait - 1))
            // Due: no longer waiting, and no timer left for it.
            assertEquals(emptySet<String>(), s.waiting(now + wait))
            assertNull(s.nextDueInMs(now + wait))
            now += wait
        }
        // The fifth stop: given up on for the service's life.
        assertTrue(s.stopped("a0000000000", now))
        assertEquals(emptySet<String>(), s.waiting(now))
        assertNull(s.nextDueInMs(now))
        // Each song counts on its own; the earliest retry due is the timer's.
        assertFalse(s.stopped("b0000000000", now - 10_000L))
        assertFalse(s.stopped("c0000000000", now))
        assertEquals(setOf("b0000000000", "c0000000000"), s.waiting(now))
        assertEquals(20_000L, s.nextDueInMs(now))
    }

    @Test
    fun aSongSavedAfterAllStartsAfreshNextTime() {
        val s = SaveStrikes()
        val now = 1_000_000L
        for (i in 0 until SaveStrikes.MAX - 1) assertFalse(s.stopped("a0000000000", now))
        // Saved after all (its fourth try worked): forgotten, no timer left for it.
        s.forget("a0000000000")
        assertEquals(emptySet<String>(), s.waiting(now))
        assertNull(s.nextDueInMs(now))
        // Cleared from the cache and in trouble again months later: it counts from the start.
        assertFalse(s.stopped("a0000000000", now))
        assertEquals(30_000L, s.nextDueInMs(now))
    }

    @Test
    fun aRetryFiresWithoutAnotherEvent() {
        // Every candidate waits for its retry (they're skipped): the timer is the earliest retry.
        val waiting = Facts(liked, saved = emptySet(), skip = liked.toSet(), retryInMs = 45_000L)
        assertEquals(45_000L, LikedSaverPolicy.recheckInMs(waiting))
        assertNull(LikedSaverPolicy.recheckInMs(waiting.copy(retryInMs = null)))
        // The gap holds back a save too: whichever ends first.
        val gap = Facts(liked, saved = emptySet(), sinceLastMs = 10_000L, retryInMs = 45_000L)
        assertEquals(LikedSaverPolicy.MIN_GAP_MS - 10_000L, LikedSaverPolicy.recheckInMs(gap))
        assertEquals(5_000L, LikedSaverPolicy.recheckInMs(gap.copy(retryInMs = 5_000L)))
        // A save starts now: it asks again when it finishes, no timer.
        assertNull(LikedSaverPolicy.recheckInMs(Facts(liked, saved = emptySet(), retryInMs = 45_000L)))
    }

    @Test
    fun theKeyNamesTheFileLengthWhenTheUrlSaysIt() {
        val k = CacheKeys.of("dQw4w9WgXcQ", 251, 3_456_789L)
        assertEquals("yt:dQw4w9WgXcQ:251:3456789", k)
        assertEquals("dQw4w9WgXcQ", CacheKeys.ytIdOf(k))
        assertEquals(251, CacheKeys.itagOf(k))
        assertTrue(CacheKeys.isYt(k))
        // Another file under the same format (a re-encode, a dubbed track): another key.
        assertFalse(k == CacheKeys.of("dQw4w9WgXcQ", 251, 3_456_790L))
        assertEquals("yt:dQw4w9WgXcQ:251", CacheKeys.of("dQw4w9WgXcQ", 251, null))
        assertFalse(CacheKeys.isYt("yt:dQw4w9WgXcQ:251:x"))
        assertFalse(CacheKeys.isYt("yt:dQw4w9WgXcQ:251:0"))
        assertEquals(3_456_789L, StreamUrls.clen("https://rr1---sn-x.googlevideo.com/videoplayback?itag=251&clen=3456789&dur=212.1"))
        assertNull(StreamUrls.clen("https://rr1---sn-x.googlevideo.com/videoplayback?itag=251"))
    }

    @Test
    fun onHighALowerCopyDoesNotStandInForTheQualityAsked() {
        // High: a 128 kbps copy won't do for a 160 kbps rung.
        val wantHigh = CacheKeys.wantedBps(AudioQuality.HIGH, rungItag = 251, ladderBps = emptyList(), online = true)
        assertEquals(160_000, wantHigh)
        assertNull(CacheKeys.pick(listOf(140), keep = null, rungItag = 251, wantedBps = wantHigh))
        assertEquals(251, CacheKeys.pick(listOf(140, 251), keep = null, rungItag = 251, wantedBps = wantHigh))
        // An AAC 256 kbps copy is at least as good.
        assertEquals(141, CacheKeys.pick(listOf(141), keep = null, rungItag = 251, wantedBps = wantHigh))
        // Without a link yet: the ladder's top, else a top-class copy.
        assertEquals(160_000, CacheKeys.wantedBps(AudioQuality.HIGH, rungItag = null, ladderBps = listOf(160_000, 128_000, 64_000, 48_000), online = true))
        assertEquals(CacheKeys.TOP_CLASS_BPS, CacheKeys.wantedBps(AudioQuality.HIGH, rungItag = null, ladderBps = emptyList(), online = true))
        assertNull(CacheKeys.pick(listOf(250), keep = null, rungItag = null, wantedBps = CacheKeys.TOP_CLASS_BPS))
        // Low, or offline: any whole copy.
        assertEquals(0, CacheKeys.wantedBps(AudioQuality.LOW, rungItag = 251, ladderBps = emptyList(), online = true))
        assertEquals(0, CacheKeys.wantedBps(AudioQuality.HIGH, rungItag = 251, ladderBps = emptyList(), online = false))
        assertEquals(140, CacheKeys.pick(listOf(140), keep = null, rungItag = 251, wantedBps = 0))
        // A resume stays in its file whatever the setting.
        assertEquals(140, CacheKeys.pick(listOf(140), keep = 140, rungItag = 251, wantedBps = wantHigh))
        // A format of unknown bitrate only when any will do.
        assertNull(CacheKeys.pick(listOf(9999), keep = null, rungItag = null, wantedBps = 64_000))
    }

    @Test
    fun onAutoAWholeCopyAlwaysWins() {
        // Auto asks for no bitrate, whatever the rung it is on or the ladder it knows.
        assertEquals(0, CacheKeys.wantedBps(AudioQuality.AUTO, rungItag = null, ladderBps = emptyList(), online = true))
        assertEquals(0, CacheKeys.wantedBps(AudioQuality.AUTO, rungItag = 251, ladderBps = listOf(160_000, 128_000, 64_000, 48_000), online = true))
        // A fresh process (no link, no ladder in memory) plays the copy saved at Low rather than
        // downloading the song again.
        val saved = CacheKeys.of("dQw4w9WgXcQ", 250, 2_000_000L)
        val wanted = CacheKeys.wantedBps(AudioQuality.AUTO, rungItag = null, ladderBps = emptyList(), online = true)
        assertEquals(saved, CacheKeys.pickKey(listOf(saved), keepKey = null, rungItag = 251, wantedBps = wanted))
        // The rung's own format still wins when it is whole too.
        val top = CacheKeys.of("dQw4w9WgXcQ", 251, 3_000_000L)
        assertEquals(top, CacheKeys.pickKey(listOf(saved, top), keepKey = null, rungItag = 251, wantedBps = wanted))
    }

    @Test
    fun aMissIsRememberedBriefly() {
        var now = 0L
        val m = CacheMisses(clock = { now })
        assertFalse(m.recent("a0000000000"))
        m.missed("a0000000000")
        assertTrue(m.recent("a0000000000"))
        now += CacheMisses.SKIP_MS
        assertFalse(m.recent("a0000000000"))
    }

    @Test
    fun membersOnlyAudioIsTaggedAndGoesAtSignOut() {
        val m = MembersAudio()
        m.mark("mem00000001")
        // Tagged once it reaches the cache (the tag list is written then).
        assertTrue(m.onCached("mem00000001"))
        assertFalse(m.onCached("mem00000001"))
        assertFalse(m.onCached("pub00000001"))
        // A tag from an earlier run (the file), not marked in this one.
        m.load(listOf("mem00000002"))
        assertEquals(setOf("mem00000001", "mem00000002"), m.tagged())
        assertFalse(m.denied("mem00000001"))
        // Signed out: every tagged or known one goes, and none comes back in until a sign-in.
        val gone = m.signOut()
        assertEquals(setOf("mem00000001", "mem00000002"), gone)
        // The tags go once the audio has (AudioCache removes it, then says so).
        m.removed(gone)
        assertEquals(emptySet<String>(), m.tagged())
        assertTrue(m.denied("mem00000001"))
        assertTrue(m.denied("mem00000002"))
        assertFalse(m.denied("pub00000001"))
        assertFalse(m.onCached("mem00000001"))
        m.signIn()
        assertFalse(m.denied("mem00000001"))
    }

    @Test
    fun aSignOutWhoseAudioCouldNotGoKeepsItsTagsForTheNextStart() {
        // The cache didn't start in this run: nothing was removed, so the tags (and the file)
        // still say which audio on the phone is members-only.
        val m = MembersAudio()
        m.load(listOf("mem00000001"))
        m.mark("mem00000002")
        assertEquals(setOf("mem00000001", "mem00000002"), m.signOut())
        assertEquals(setOf("mem00000001"), m.tagged())
        // The next start loads them, and its sign-out removes that audio.
        val next = MembersAudio()
        next.load(m.tagged())
        assertEquals(setOf("mem00000001"), next.signOut())
    }

    @Test
    fun membersOnlyMarkedWhileTheCacheStartsIsTaggedOrRemovedOnceStarted() {
        val m = MembersAudio()
        // The start counted its audio before the page said it is members-only: no tag then.
        assertFalse(m.onCached("mem00000001"))
        m.mark("mem00000001")
        m.mark("mem00000002")
        assertEquals(setOf("mem00000001", "mem00000002"), m.marked())
        // Started: of those marked so far, the one with audio in the cache is tagged.
        assertEquals(MembersAudio.Reconciled(remove = emptyList(), tagged = true), m.reconcile(listOf("mem00000001")))
        assertEquals(setOf("mem00000001"), m.tagged())
        // Again: nothing new to write down.
        assertFalse(m.reconcile(listOf("mem00000001")).tagged)
        // Signed out: its audio is removed instead, and nothing is tagged.
        val out = MembersAudio()
        out.signOut()
        out.mark("mem00000003")
        assertEquals(MembersAudio.Reconciled(remove = listOf("mem00000003"), tagged = false), out.reconcile(listOf("mem00000003")))
        assertEquals(emptySet<String>(), out.tagged())
    }

    // ---- liked songs never recognised as saved ----

    @Test
    fun youtubeAudioIsCachedEvenWithoutAContentLength() {
        // ExoPlayer's progressive loads ask not to be cached when the response has no length
        // (a live stream, it assumes); googlevideo's POST answer may have none. A `yt:` load is
        // a file of known length: cached anyway, its length stored at its end.
        val progressive = DataSpec.FLAG_DONT_CACHE_IF_LENGTH_UNKNOWN or DataSpec.FLAG_ALLOW_CACHE_FRAGMENTATION
        assertEquals(DataSpec.FLAG_ALLOW_CACHE_FRAGMENTATION, CacheKeys.cacheFlags(progressive))
        assertEquals(DataSpec.FLAG_ALLOW_GZIP, CacheKeys.cacheFlags(DataSpec.FLAG_ALLOW_GZIP))
        assertEquals(0, CacheKeys.cacheFlags(0))
    }

    @Test
    fun thePlayingAndNextTracksAreSkippedOnlyWhileThePlayerStillLoadsThem() {
        val cur = "cur00000000"
        val next = "nxt00000000"
        val loaded = PlaybackNeed.Load(
            idle = false, buffering = false, positionMs = 10_000, durationMs = 200_000,
            bufferedPositionMs = 200_000, totalBufferedMs = 190_000 + 180_000, hasNext = true, nextDurationMs = 180_000,
        )
        // Both all buffered: the player won't write them into the cache any more, the saver may.
        assertEquals(emptySet<String>(), PlaybackNeed.stillLoading(loaded, cur, next))
        // Ended or idle (a restored session, an error): nothing is loading.
        val notLoaded = loaded.copy(bufferedPositionMs = 0, totalBufferedMs = 0)
        assertEquals(emptySet<String>(), PlaybackNeed.stillLoading(notLoaded.copy(idle = true), cur, next))
        // The current one partly buffered: it is loading, and the next comes after it.
        assertEquals(setOf(cur, next), PlaybackNeed.stillLoading(notLoaded.copy(bufferedPositionMs = 120_000, totalBufferedMs = 110_000), cur, next))
        assertEquals(setOf(cur, next), PlaybackNeed.stillLoading(loaded.copy(durationMs = -1), cur, next))
        // The current one whole, the next not (yet): only the next.
        assertEquals(setOf(next), PlaybackNeed.stillLoading(loaded.copy(totalBufferedMs = 190_000 + 60_000), cur, next))
        assertEquals(setOf(next), PlaybackNeed.stillLoading(loaded.copy(nextDurationMs = -1, totalBufferedMs = 190_000), cur, next))
        // No next track.
        assertEquals(emptySet<String>(), PlaybackNeed.stillLoading(loaded.copy(hasNext = false), cur, null))
        // The saver then repairs a liked song that is playing, all buffered.
        val f = Facts(liked, saved = emptySet(), skip = PlaybackNeed.stillLoading(loaded, "new00000000", "mid00000000"))
        assertEquals("new00000000", LikedSaverPolicy.next(f))
    }

    @Test
    fun afterClearCacheThePlayingLikedSongIsSavedAgainOnAnyNetwork() {
        // Cleared while a liked song plays (and the next is liked): their bytes are in the
        // player's memory, so nothing writes them back. They count as liked just now.
        val fresh = LikedSaverPolicy.freshAfterClear(liked, pair = setOf("mid00000000", "notliked000"))
        assertEquals(setOf("mid00000000"), fresh)
        val f = Facts(liked, saved = emptySet(), fresh = fresh, unmetered = false, sinceLastMs = 1_000L)
        // While the player still loads it: not yet. Loaded: saved, on mobile data too.
        assertNull(LikedSaverPolicy.next(f.copy(skip = setOf("mid00000000"))))
        assertEquals("mid00000000", LikedSaverPolicy.next(f))
    }

    @Test
    fun aSaveCountsOnlyWhenTheSongIsWholeInTheCache() {
        // The writer finished, but playback held the span (its lock): read past, not written.
        assertEquals(SaveOutcome.STOPPED, SaveOutcome.afterWrite(whole = false))
        assertEquals(SaveOutcome.SAVED, SaveOutcome.afterWrite(whole = true))
    }
}
