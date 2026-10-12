package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.net.BlockReason
import io.github.iamandelib.cyberjuke.net.FailureKind
import io.github.iamandelib.cyberjuke.playback.TrackErrorPolicy.Action
import io.github.iamandelib.cyberjuke.playback.TrackErrorPolicy.Facts
import io.github.iamandelib.cyberjuke.yt.RateLimitedException
import io.github.iamandelib.cyberjuke.yt.YtCompat
import org.junit.Assert.assertEquals
import org.junit.Test
import org.schabi.newpipe.extractor.exceptions.AgeRestrictedContentException
import org.schabi.newpipe.extractor.exceptions.ContentNotAvailableException
import org.schabi.newpipe.extractor.exceptions.ExtractionException
import org.schabi.newpipe.extractor.exceptions.GeographicRestrictionException
import org.schabi.newpipe.extractor.exceptions.ParsingException
import org.schabi.newpipe.extractor.exceptions.PrivateContentException
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import org.schabi.newpipe.extractor.exceptions.SignInConfirmNotBotException
import java.io.IOException
import java.net.SocketTimeoutException

class TrackErrorPolicyTest {

    private fun decideFor(t: Throwable, consecutive: Int = 0) =
        TrackErrorPolicy.decide(Facts(kind = YtCompat.classify(t), consecutiveFailures = consecutive))

    @Test
    fun botCheckPausesWithBackOffInsteadOfSkipping() {
        // The plan's resilience check: a stubbed SignInConfirmNotBotException must not skip.
        val e = SignInConfirmNotBotException("Sign in to confirm you're not a bot")
        assertEquals(FailureKind.BOT_CHECK, YtCompat.classify(e))
        assertEquals(Action.Block(BlockReason.BOT_CHECK), decideFor(e))
        // ...even after earlier per-video failures (no skip, no stop).
        assertEquals(Action.Block(BlockReason.BOT_CHECK), decideFor(e, consecutive = 4))
    }

    @Test
    fun rateLimitsAreNetworkWide() {
        assertEquals(Action.Block(BlockReason.RATE_LIMIT), decideFor(RateLimitedException("https://www.youtube.com/")))
        assertEquals(Action.Block(BlockReason.BOT_CHECK), decideFor(ReCaptchaException("captcha", "https://www.google.com/sorry")))
        val tryLater = ContentNotAvailableException("Got error UNPLAYABLE: \"This content isn't available, try again later.\"")
        assertEquals(FailureKind.RATE_LIMIT, YtCompat.classify(tryLater))
        // Another video's player response swapped in: YouTube rate-limiting the IP.
        assertEquals(FailureKind.RATE_LIMIT, YtCompat.classify(ExtractionException("VISIONOS player response is not valid")))
        // A 429 on a stream gets one fresh link first; a second one is a block.
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(Facts(kind = null, httpCode = 429)))
        assertEquals(
            Action.Block(BlockReason.RATE_LIMIT),
            TrackErrorPolicy.decide(Facts(kind = null, httpCode = 429, alreadyReResolved = true)),
        )
    }

    @Test
    fun perVideoErrorsSkipWithTheFiveInARowGuard() {
        for (e in listOf(
            PrivateContentException("private"),
            AgeRestrictedContentException("age"),
            GeographicRestrictionException("geo"),
            ContentNotAvailableException("Got error ERROR: \"Video unavailable\""),
        )) {
            assertEquals(FailureKind.CONTENT, YtCompat.classify(e))
            assertEquals(Action.Skip, decideFor(e))
        }
        val e = PrivateContentException("private")
        assertEquals(Action.Skip, decideFor(e, consecutive = 3))
        assertEquals(Action.Stop, decideFor(e, consecutive = 4))
        assertEquals(
            Action.PauseAtEnd,
            TrackErrorPolicy.decide(Facts(kind = FailureKind.CONTENT, hasNext = false)),
        )
        assertEquals(
            Action.Skip, // an upcoming item is dropped even at the end of the list
            TrackErrorPolicy.decide(Facts(kind = FailureKind.CONTENT, isCurrent = false, hasNext = false)),
        )
    }

    @Test
    fun brokenExtractorAndNetworkPauseWithoutSkipping() {
        assertEquals(FailureKind.BROKEN, YtCompat.classify(ParsingException("Could not get name")))
        // Not the connection: the web names the track, as for any other failure.
        assertEquals(Action.Pause(resume = false, network = false), decideFor(ParsingException("Could not get name")))
        assertEquals(FailureKind.NETWORK, YtCompat.classify(SocketTimeoutException()))
        assertEquals(FailureKind.NETWORK, YtCompat.classify(ExtractionException("wrapped", IOException("reset"))))
        assertEquals(Action.Pause(resume = true), decideFor(IOException("offline")))
        assertEquals(Action.Pause(resume = true), TrackErrorPolicy.decide(Facts(kind = null, ioNetwork = true)))
        // A server error: the resume asks for a fresh link (another server), not the dead URL.
        assertEquals(Action.Pause(resume = true, freshLink = true), TrackErrorPolicy.decide(Facts(kind = null, httpCode = 503)))
        // Each outage tells the web it was the connection, not the track.
        for (f in listOf(Facts(kind = FailureKind.NETWORK), Facts(kind = null, ioNetwork = true), Facts(kind = null, httpCode = 503))) {
            assertEquals(true, (TrackErrorPolicy.decide(f) as Action.Pause).network)
        }
    }

    @Test
    fun anOutageThatKeepsFailingStopsResumingByItself() {
        // Online again, failing again: a few tries, then it waits for Play (no endless loop).
        val last = TrackErrorPolicy.MAX_OUTAGE_RESUMES - 1
        assertEquals(Action.Pause(resume = true), TrackErrorPolicy.decide(Facts(kind = null, ioNetwork = true, outagePauses = last - 1)))
        assertEquals(Action.Pause(resume = false), TrackErrorPolicy.decide(Facts(kind = null, ioNetwork = true, outagePauses = last)))
        assertEquals(Action.Pause(resume = false, freshLink = true), TrackErrorPolicy.decide(Facts(kind = null, httpCode = 502, outagePauses = last)))
        assertEquals(Action.Pause(resume = false), TrackErrorPolicy.decide(Facts(kind = FailureKind.NETWORK, outagePauses = last)))
        // Still the connection, so the web says to press Play once back online.
        assertEquals(true, (TrackErrorPolicy.decide(Facts(kind = null, ioNetwork = true, outagePauses = last)) as Action.Pause).network)
    }

    @Test
    fun anUnclearIoFailureIsAnOutageWhenTheNetworkIsDown() {
        // A reset connection or an early end of stream, and no validated network: the next
        // track would fail too, so pause and resume instead of skipping a good track.
        val noNetwork = Facts(kind = null, ioOther = true, networkValidated = false)
        assertEquals(Action.Pause(resume = true), TrackErrorPolicy.decide(noNetwork))
        // ...also with failures before it: no five-in-a-row stop on a flapping link.
        assertEquals(Action.Pause(resume = true), TrackErrorPolicy.decide(noNetwork.copy(consecutiveFailures = 4)))
        // ...and for an upcoming item at the end of the list.
        assertEquals(Action.Pause(resume = true), TrackErrorPolicy.decide(noNetwork.copy(isCurrent = false, hasNext = false)))
    }

    @Test
    fun anUnclearIoFailureIsAnOutageWhenThisTrackWasPlaying() {
        // Its stream worked until now: the link dropped, not the file.
        val midTrack = Facts(kind = null, ioOther = true, networkValidated = true, playedThisItem = true)
        assertEquals(Action.Pause(resume = true), TrackErrorPolicy.decide(midTrack))
        assertEquals(Action.Pause(resume = true), TrackErrorPolicy.decide(midTrack.copy(consecutiveFailures = 4)))
    }

    @Test
    fun anUnclearIoFailureOnAFreshTrackWithTheNetworkUpIsTheTracks() {
        // Never played, and the network is fine: this file, so skip it as before.
        val fresh = Facts(kind = null, ioOther = true, networkValidated = true, playedThisItem = false)
        assertEquals(Action.Skip, TrackErrorPolicy.decide(fresh))
        assertEquals(Action.Stop, TrackErrorPolicy.decide(fresh.copy(consecutiveFailures = 4)))
        assertEquals(Action.PauseAtEnd, TrackErrorPolicy.decide(fresh.copy(hasNext = false)))
        // A plain per-video failure is unchanged by the network's state.
        assertEquals(Action.Skip, TrackErrorPolicy.decide(Facts(kind = null, networkValidated = false)))
    }

    @Test
    fun anUnclearIoFailureNeverOverridesWhatAStatusOrTheResolverSays() {
        val down = Facts(kind = null, ioOther = true, networkValidated = false, playedThisItem = true)
        // An HTTP status is its own answer (a refusal, an expired link).
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(down.copy(httpCode = 403, urlAgeMs = 3L * 3600_000L)))
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(down.copy(httpCode = 429)))
        // So is the resolver's kind.
        assertEquals(Action.Skip, TrackErrorPolicy.decide(down.copy(kind = FailureKind.CONTENT)))
        assertEquals(Action.Block(BlockReason.BOT_CHECK), TrackErrorPolicy.decide(down.copy(kind = FailureKind.BOT_CHECK)))
        assertEquals(Action.Pause(resume = false), TrackErrorPolicy.decide(down.copy(kind = FailureKind.BROKEN)))
    }

    @Test
    fun aTrackBrokenAtOneSpotIsSkippedTheSecondTimeThere() {
        // The network is up and the track played up to here: once an outage...
        val midTrack = Facts(kind = null, ioOther = true, networkValidated = true, playedThisItem = true)
        assertEquals(Action.Pause(resume = true), TrackErrorPolicy.decide(midTrack.copy(failuresHere = 0)))
        // ...but failing at the same spot again, it's the file: skip it instead of looping.
        assertEquals(Action.Skip, TrackErrorPolicy.decide(midTrack.copy(failuresHere = 1)))
        assertEquals(Action.PauseAtEnd, TrackErrorPolicy.decide(midTrack.copy(failuresHere = 1, hasNext = false)))
        // With the network down too: the first time there an outage, the second the file's.
        val down = midTrack.copy(networkValidated = false)
        assertEquals(Action.Pause(resume = true), TrackErrorPolicy.decide(down))
        assertEquals(Action.Skip, TrackErrorPolicy.decide(down.copy(failuresHere = 1)))
        assertEquals(Action.Skip, TrackErrorPolicy.decide(down.copy(playedThisItem = false, failuresHere = 1)))
    }

    @Test
    fun onlyTheUnclearFailureCountsAtItsSpot() {
        val unclear = Facts(kind = null, ioOther = true)
        assertEquals(true, TrackErrorPolicy.countsAtSpot(unclear))
        // A reset socket during a connection failure is that connection failure: an outage
        // every time, never counted toward a skip.
        assertEquals(false, TrackErrorPolicy.countsAtSpot(unclear.copy(ioNetwork = true)))
        assertEquals(false, TrackErrorPolicy.countsAtSpot(unclear.copy(httpCode = 503)))
        assertEquals(false, TrackErrorPolicy.countsAtSpot(unclear.copy(kind = FailureKind.NETWORK)))
        assertEquals(false, TrackErrorPolicy.countsAtSpot(unclear.copy(blocked = true)))
        assertEquals(false, TrackErrorPolicy.countsAtSpot(Facts(kind = null)))
    }

    @Test
    fun aTrackPausedOnAfterPlayingKeepsItsFormat() {
        val outage = Action.Pause(resume = true)
        // Played (or past its start) and paused on: it loads again in the same format.
        assertEquals(true, TrackErrorPolicy.keepsFormat(outage, isCurrent = true, played = true, positionMs = 0L))
        assertEquals(true, TrackErrorPolicy.keepsFormat(outage, isCurrent = true, played = false, positionMs = 40_000L))
        assertEquals(true, TrackErrorPolicy.keepsFormat(Action.Pause(resume = false), true, true, 1L))
        assertEquals(true, TrackErrorPolicy.keepsFormat(Action.Block(BlockReason.RATE_LIMIT), true, true, 1L))
        assertEquals(true, TrackErrorPolicy.keepsFormat(Action.WaitBlocked, true, true, 1L))
        // Never started: the rung of the moment is fine.
        assertEquals(false, TrackErrorPolicy.keepsFormat(outage, isCurrent = true, played = false, positionMs = 0L))
        // An upcoming item, or a skip / re-resolve (which keeps its own itag): nothing to keep.
        assertEquals(false, TrackErrorPolicy.keepsFormat(outage, isCurrent = false, played = true, positionMs = 5L))
        assertEquals(false, TrackErrorPolicy.keepsFormat(Action.Skip, true, true, 5L))
        assertEquals(false, TrackErrorPolicy.keepsFormat(Action.ReResolve, true, true, 5L))
    }

    @Test
    fun failuresCountPerSpotOfOneTrack() {
        val spot = FailureSpot()
        assertEquals(0, spot.onFailure("a", 60_000L))
        // Resumed, played the buffer up to about the same place, failed again.
        assertEquals(1, spot.onFailure("a", 75_000L))
        assertEquals(2, spot.onFailure("a", 70_000L))
        // Well past it (more than 30 s on): a new spot.
        assertEquals(0, spot.onFailure("a", 110_000L))
        // Another track, or a cleared one: starts over.
        assertEquals(0, spot.onFailure("b", 110_000L))
        spot.clear()
        assertEquals(0, spot.onFailure("b", 110_000L))
    }

    @Test
    fun theOutageStreakLeavesRoomForTheScheduledTries() {
        // ResumeSchedule tries six times within its window (ResumeScheduleTest); the network
        // callback may add one or two.
        val tries = 6
        assertEquals(true, TrackErrorPolicy.MAX_OUTAGE_RESUMES > tries + 1)
        val unclear = Facts(kind = null, ioOther = true, networkValidated = false)
        assertEquals(Action.Pause(resume = true), TrackErrorPolicy.decide(unclear.copy(outagePauses = tries)))
        assertEquals(
            Action.Pause(resume = false),
            TrackErrorPolicy.decide(unclear.copy(outagePauses = TrackErrorPolicy.MAX_OUTAGE_RESUMES - 1)),
        )
    }

    @Test
    fun forbiddenOnAFreshUrlGetsOneFreshLinkThenBlocks() {
        val fresh = Facts(kind = null, httpCode = 403, urlAgeMs = 5_000L)
        // Retry once before calling it a block: the extraction tells whether we're blocked.
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(fresh))
        val old = Facts(kind = null, httpCode = 403, urlAgeMs = 3L * 3600_000L)
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(old))
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(old.copy(urlAgeMs = null)))
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(Facts(kind = null, httpCode = 410, urlAgeMs = 1L)))
        // Re-resolved once already and still failing on an old URL: give up on this item.
        assertEquals(Action.Skip, TrackErrorPolicy.decide(old.copy(alreadyReResolved = true)))
        // The re-resolved URL is fresh: a second 403 means stream-token enforcement.
        assertEquals(
            Action.Block(BlockReason.STREAM_FORBIDDEN),
            TrackErrorPolicy.decide(fresh.copy(alreadyReResolved = true)),
        )
    }

    @Test
    fun forbiddenAfterANetworkSwitchReResolves() {
        // H1: a 60 s old URL bound to the Wi-Fi IP, requested from LTE.
        val switched = Facts(kind = null, httpCode = 403, urlAgeMs = 60_000L, resolvedBeforeNetworkChange = true)
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(switched))
        // The URL resolved on the new network is refused too: that is enforcement.
        assertEquals(
            Action.Block(BlockReason.STREAM_FORBIDDEN),
            TrackErrorPolicy.decide(switched.copy(resolvedBeforeNetworkChange = false, alreadyReResolved = true)),
        )
        // Y5: a URL past its own expire re-resolves, whatever its age says.
        val expired = Facts(kind = null, httpCode = 403, urlAgeMs = 5_000L, urlExpired = true)
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(expired))
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(expired.copy(httpCode = 410)))
        // 429 stays a rate limit once a fresh link was refused too.
        assertEquals(
            Action.Block(BlockReason.RATE_LIMIT),
            TrackErrorPolicy.decide(switched.copy(httpCode = 429, alreadyReResolved = true)),
        )
    }

    @Test
    fun aRefusalOverIpv6SwitchesToIpv4WhenTheSettingIsAuto() {
        val fresh403 = Facts(kind = null, httpCode = 403, urlAgeMs = 5_000L, viaIpv6 = true, canSwitchToIpv4 = true)
        assertEquals(Action.SwitchToIpv4, TrackErrorPolicy.decide(fresh403))
        assertEquals(Action.SwitchToIpv4, TrackErrorPolicy.decide(fresh403.copy(httpCode = 429, urlAgeMs = null)))
        // Already on IPv4 (or the setting is Always / Off): one fresh link, as before.
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(fresh403.copy(canSwitchToIpv4 = false)))
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(fresh403.copy(viaIpv6 = false)))
        // Switched and refused again: a block.
        assertEquals(
            Action.Block(BlockReason.STREAM_FORBIDDEN),
            TrackErrorPolicy.decide(fresh403.copy(alreadyReResolved = true)),
        )
        // An old URL's 403 is expiry, not a refusal: no switch.
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(fresh403.copy(urlAgeMs = 3L * 3600_000L)))
    }

    @Test
    fun aForbiddenRightAfterANetworkSwitchIsNoReasonToSwitchToIpv4() {
        // Resolved 20 s ago on Wi-Fi (IPv6), requested from mobile data: bound to the old IP.
        val moved = Facts(
            kind = null, httpCode = 403, urlAgeMs = 20_000L, viaIpv6 = true, canSwitchToIpv4 = true,
            resolvedBeforeNetworkChange = true,
        )
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(moved))
        // Same for a URL past its own expire.
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(moved.copy(resolvedBeforeNetworkChange = false, urlExpired = true)))
        // Re-resolved, and the network changed again before it loaded (the IPv6 address came a
        // second later): still bound to an old IP, so another fresh link, not a block or a skip.
        assertEquals(Action.ReResolve, TrackErrorPolicy.decide(moved.copy(alreadyReResolved = true)))
        // A 429 is a refusal wherever the URL came from.
        assertEquals(Action.SwitchToIpv4, TrackErrorPolicy.decide(moved.copy(httpCode = 429)))
    }

    @Test
    fun runningBackOffJustWaits() {
        assertEquals(Action.WaitBlocked, TrackErrorPolicy.decide(Facts(kind = null, blocked = true)))
    }

    @Test
    fun onlyNetworkFailuresAreRetried() {
        assertEquals(false, ResolveException("x", "m", null, FailureKind.NETWORK).permanent)
        for (k in FailureKind.values().filter { it != FailureKind.NETWORK }) {
            assertEquals(true, ResolveException("x", "m", null, k).permanent)
        }
    }
}
