package io.github.iamandelib.cyberjuke.playback

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
        // The song itself: given up on. The connection: a strike (three and it's given up on).
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
    fun aSongThatKeepsFailingIsGivenUpOn() {
        val s = SaveStrikes()
        assertFalse(s.stopped("a0000000000"))
        assertFalse(s.stopped("a0000000000"))
        assertTrue(s.stopped("a0000000000"))
        assertFalse(s.stopped("b0000000000"))
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
    fun onlineALowerCopyDoesNotStandInForTheQualityAsked() {
        // High (or Auto at the top rung): a 128 kbps copy won't do for a 160 kbps rung.
        val wantHigh = CacheKeys.wantedBps(AudioQuality.HIGH, 0, rungItag = 251, ladderBps = emptyList(), online = true)
        assertEquals(160_000, wantHigh)
        assertNull(CacheKeys.pick(listOf(140), keep = null, rungItag = 251, wantedBps = wantHigh))
        assertEquals(251, CacheKeys.pick(listOf(140, 251), keep = null, rungItag = 251, wantedBps = wantHigh))
        // An AAC 256 kbps copy is at least as good.
        assertEquals(141, CacheKeys.pick(listOf(141), keep = null, rungItag = 251, wantedBps = wantHigh))
        // Without a link yet: the ladder's rung, else High wants a top-class copy.
        assertEquals(64_000, CacheKeys.wantedBps(AudioQuality.AUTO, 2, rungItag = null, ladderBps = listOf(160_000, 128_000, 64_000, 48_000), online = true))
        assertEquals(CacheKeys.TOP_CLASS_BPS, CacheKeys.wantedBps(AudioQuality.HIGH, 0, rungItag = null, ladderBps = emptyList(), online = true))
        assertNull(CacheKeys.pick(listOf(250), keep = null, rungItag = null, wantedBps = CacheKeys.TOP_CLASS_BPS))
        // Low, Auto lower down, or offline: any whole copy.
        assertEquals(0, CacheKeys.wantedBps(AudioQuality.LOW, 0, rungItag = 251, ladderBps = emptyList(), online = true))
        assertEquals(0, CacheKeys.wantedBps(AudioQuality.HIGH, 0, rungItag = 251, ladderBps = emptyList(), online = false))
        assertEquals(140, CacheKeys.pick(listOf(140), keep = null, rungItag = 251, wantedBps = 0))
        // A resume stays in its file whatever the setting.
        assertEquals(140, CacheKeys.pick(listOf(140), keep = 140, rungItag = 251, wantedBps = wantHigh))
        // A format of unknown bitrate only when any will do.
        assertNull(CacheKeys.pick(listOf(9999), keep = null, rungItag = null, wantedBps = 64_000))
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
        assertEquals(setOf("mem00000001", "mem00000002"), m.signOut())
        assertEquals(emptySet<String>(), m.tagged())
        assertTrue(m.denied("mem00000001"))
        assertTrue(m.denied("mem00000002"))
        assertFalse(m.denied("pub00000001"))
        assertFalse(m.onCached("mem00000001"))
        m.signIn()
        assertFalse(m.denied("mem00000001"))
    }
}
