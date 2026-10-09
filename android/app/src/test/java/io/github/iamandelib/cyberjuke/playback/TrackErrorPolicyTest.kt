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
        assertEquals(Action.Pause(resume = false), decideFor(ParsingException("Could not get name")))
        assertEquals(FailureKind.NETWORK, YtCompat.classify(SocketTimeoutException()))
        assertEquals(FailureKind.NETWORK, YtCompat.classify(ExtractionException("wrapped", IOException("reset"))))
        assertEquals(Action.Pause(resume = true), decideFor(IOException("offline")))
        assertEquals(Action.Pause(resume = true), TrackErrorPolicy.decide(Facts(kind = null, ioNetwork = true)))
        // A server error: the resume asks for a fresh link (another server), not the dead URL.
        assertEquals(Action.Pause(resume = true, freshLink = true), TrackErrorPolicy.decide(Facts(kind = null, httpCode = 503)))
    }

    @Test
    fun anOutageThatKeepsFailingStopsResumingByItself() {
        // Online again, failing again: a few tries, then it waits for Play (no endless loop).
        val last = TrackErrorPolicy.MAX_OUTAGE_RESUMES - 1
        assertEquals(Action.Pause(resume = true), TrackErrorPolicy.decide(Facts(kind = null, ioNetwork = true, outagePauses = last - 1)))
        assertEquals(Action.Pause(resume = false), TrackErrorPolicy.decide(Facts(kind = null, ioNetwork = true, outagePauses = last)))
        assertEquals(Action.Pause(resume = false, freshLink = true), TrackErrorPolicy.decide(Facts(kind = null, httpCode = 502, outagePauses = last)))
        assertEquals(Action.Pause(resume = false), TrackErrorPolicy.decide(Facts(kind = FailureKind.NETWORK, outagePauses = last)))
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
