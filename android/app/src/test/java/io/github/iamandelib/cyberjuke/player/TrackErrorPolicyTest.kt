package io.github.iamandelib.cyberjuke.player

import io.github.iamandelib.cyberjuke.net.BlockReason
import io.github.iamandelib.cyberjuke.net.FailureKind
import io.github.iamandelib.cyberjuke.player.TrackErrorPolicy.Action
import io.github.iamandelib.cyberjuke.player.TrackErrorPolicy.Facts
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
        assertEquals(Action.Block(BlockReason.RATE_LIMIT), TrackErrorPolicy.decide(Facts(kind = null, httpCode = 429)))
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
        assertEquals(Action.Pause(broken = true), decideFor(ParsingException("Could not get name")))
        assertEquals(FailureKind.NETWORK, YtCompat.classify(SocketTimeoutException()))
        assertEquals(FailureKind.NETWORK, YtCompat.classify(ExtractionException("wrapped", IOException("reset"))))
        assertEquals(Action.Pause(broken = false), decideFor(IOException("offline")))
        assertEquals(Action.Pause(broken = false), TrackErrorPolicy.decide(Facts(kind = null, ioNetwork = true)))
        assertEquals(Action.Pause(broken = false), TrackErrorPolicy.decide(Facts(kind = null, httpCode = 503)))
    }

    @Test
    fun forbiddenOnAFreshUrlIsABlockOnAnOldOneAReResolve() {
        val fresh = Facts(kind = null, httpCode = 403, urlAgeMs = 5_000L)
        assertEquals(Action.Block(BlockReason.STREAM_FORBIDDEN), TrackErrorPolicy.decide(fresh))
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
