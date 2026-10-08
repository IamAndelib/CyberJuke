package io.github.iamandelib.cyberjuke.player

import io.github.iamandelib.cyberjuke.net.FailureKind
import org.schabi.newpipe.extractor.MediaFormat
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.exceptions.AgeRestrictedContentException
import org.schabi.newpipe.extractor.exceptions.ContentNotAvailableException
import org.schabi.newpipe.extractor.exceptions.ExtractionException
import org.schabi.newpipe.extractor.exceptions.GeographicRestrictionException
import org.schabi.newpipe.extractor.exceptions.PaidContentException
import org.schabi.newpipe.extractor.exceptions.PrivateContentException
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import org.schabi.newpipe.extractor.exceptions.SignInConfirmNotBotException
import org.schabi.newpipe.extractor.services.youtube.YoutubeParsingHelper
import org.schabi.newpipe.extractor.stream.AudioTrackType
import org.schabi.newpipe.extractor.stream.DeliveryMethod
import org.schabi.newpipe.extractor.stream.StreamInfo
import java.io.IOException

/**
 * The ONLY file that touches the NewPipeExtractor stream API (checked against commit
 * 65cabc2ba5216ee871ace4a9963c08bdbf5d5dc0, which only asks YouTube's visionOS client for
 * streams: the ANDROID, iOS and WEB_EMBEDDED_PLAYER clients were removed upstream, PR #1529).
 * If a NewPipeExtractor bump breaks compilation, the fix should be confined to this file.
 */
internal object YtCompat {

    /** Plain data the rest of the player uses, independent of NewPipe types. */
    data class Candidate(
        val url: String,
        val itag: Int,             // YouTube format id; -1 if unknown
        val bitrate: Int,          // bits per second-ish; -1 if unknown
        val mimeType: String?,     // e.g. audio/mp4, audio/webm
        val kind: Kind,
        val originalTrack: Boolean, // false for dubbed/descriptive audio tracks
    )

    enum class Kind { AUDIO_PROGRESSIVE, MUXED_PROGRESSIVE }

    data class Extracted(
        val audio: List<Candidate>,
        val muxed: List<Candidate>,
        val hlsUrl: String?,
        val dashMpdUrl: String?,
        val durationSec: Long,
    )

    @Volatile private var initialized = false

    @Synchronized
    fun ensureInit() {
        if (initialized) return
        NewPipe.init(DownloaderImpl.get())
        initialized = true
    }

    /** Blocking network call. Never call on the main thread. */
    fun extract(ytId: String): Extracted {
        ensureInit()
        val info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=$ytId")

        val audio = info.audioStreams
            .filter { it.deliveryMethod == DeliveryMethod.PROGRESSIVE_HTTP && it.isUrl }
            .map {
                // getBitrate() is bps from the player response; getAverageBitrate() is the
                // static itag table value in kbps.
                val bitrate = when {
                    it.bitrate > 0 -> it.bitrate
                    it.averageBitrate > 0 -> it.averageBitrate * 1000
                    else -> -1
                }
                Candidate(
                    url = it.content,
                    itag = it.itag,
                    bitrate = bitrate,
                    mimeType = it.format?.mimeType,
                    kind = Kind.AUDIO_PROGRESSIVE,
                    originalTrack = it.audioTrackType == null ||
                        it.audioTrackType == AudioTrackType.ORIGINAL,
                )
            }

        val muxed = info.videoStreams
            .filter { it.deliveryMethod == DeliveryMethod.PROGRESSIVE_HTTP && it.isUrl && !it.isVideoOnly() }
            .map {
                Candidate(
                    url = it.content,
                    itag = it.itag,
                    // Rank muxed streams by height: lowest first is what we want.
                    bitrate = it.height,
                    mimeType = it.format?.mimeType,
                    kind = Kind.MUXED_PROGRESSIVE,
                    originalTrack = true,
                )
            }

        return Extracted(
            audio = audio,
            muxed = muxed,
            hlsUrl = info.hlsUrl?.takeIf { it.isNotBlank() },
            dashMpdUrl = info.dashMpdUrl?.takeIf { it.isNotBlank() },
            durationSec = info.duration,
        )
    }

    /** m4a (AAC) is the most widely decodable; opus/webm is a close second. */
    fun isPreferredContainer(mimeType: String?): Boolean =
        mimeType == MediaFormat.M4A.mimeType || mimeType == MediaFormat.WEBMA.mimeType

    /**
     * HTTP headers googlevideo expects for a stream URL. Mirrors what NewPipe's
     * YoutubeHttpDataSource does (desktop UA, except visionOS client URLs; web-client
     * URLs also need Origin/Referer).
     */
    fun streamHeaders(url: String): Map<String, String> {
        val headers = HashMap<String, String>()
        headers["User-Agent"] = if (YoutubeParsingHelper.isVisionOsStreamingUrl(url)) {
            YoutubeParsingHelper.getVisionOsUserAgent(null)
        } else {
            DownloaderImpl.USER_AGENT
        }
        if (YoutubeParsingHelper.isWebStreamingUrl(url)) {
            headers["Origin"] = "https://www.youtube.com"
            headers["Referer"] = "https://www.youtube.com/"
            headers["Sec-Fetch-Dest"] = "empty"
            headers["Sec-Fetch-Mode"] = "cors"
            headers["Sec-Fetch-Site"] = "cross-site"
        }
        return headers
    }

    /** SOCS consent cookie, so requests are not redirected to consent.youtube.com. */
    fun consentCookie(): String = YoutubeParsingHelper.generateConsentCookie()

    /** Classify an extraction failure into a short, log-greppable reason. */
    fun describe(t: Throwable): String = when (t) {
        is SignInConfirmNotBotException ->
            "BOT_CHECK: YouTube asks to sign in to confirm you're not a bot (IP blocked?): ${t.message}"
        is RateLimitedException -> "BOT_CHECK: rate limited by YouTube (HTTP 429): ${t.message}"
        is ReCaptchaException -> "BOT_CHECK: reCAPTCHA from YouTube: ${t.message}"
        is AgeRestrictedContentException -> "AGE_RESTRICTED: ${t.message}"
        is GeographicRestrictionException -> "GEO_BLOCKED: ${t.message}"
        is PrivateContentException -> "PRIVATE: ${t.message}"
        is PaidContentException -> "PAID: ${t.message}"
        is ContentNotAvailableException ->
            if (isTryAgainLater(t)) "BOT_CHECK: rate limited (try again later): ${t.message}"
            else "UNAVAILABLE: ${t.message}"
        else -> "${classify(t)}: ${t.javaClass.simpleName}: ${t.message}"
    }

    /**
     * What a failure means for the player (see [FailureKind]): a bot check or rate limit is
     * network-wide, a ContentNotAvailableException is about this video, a parsing failure means
     * YouTube changed something, and an I/O failure anywhere in the cause chain is the network.
     */
    fun classify(t: Throwable): FailureKind = when (t) {
        is SignInConfirmNotBotException -> FailureKind.BOT_CHECK
        is RateLimitedException -> FailureKind.RATE_LIMIT
        is ReCaptchaException -> FailureKind.BOT_CHECK
        // YouTube's per-IP throttling shows up as UNPLAYABLE "This content isn't available,
        // try again later." on every video: a rate limit, not a broken track.
        is ContentNotAvailableException -> if (isTryAgainLater(t)) FailureKind.RATE_LIMIT else FailureKind.CONTENT
        is IOException -> FailureKind.NETWORK
        is ExtractionException -> if (hasIoCause(t)) FailureKind.NETWORK else FailureKind.BROKEN
        else -> if (hasIoCause(t)) FailureKind.NETWORK else FailureKind.OTHER
    }

    private fun isTryAgainLater(t: Throwable): Boolean =
        t.message?.contains("try again later", ignoreCase = true) == true

    private fun hasIoCause(t: Throwable): Boolean {
        var c: Throwable? = t.cause
        var depth = 0
        while (c != null && depth < 8) {
            if (c is IOException) return true
            c = c.cause
            depth++
        }
        return false
    }

    /** True if retrying the same video soon is pointless. */
    fun isPermanent(t: Throwable): Boolean = classify(t) != FailureKind.NETWORK
}

/**
 * HTTP 429 from YouTube, thrown by [DownloaderImpl]. A [ReCaptchaException] so NewPipe treats
 * it like before; [YtCompat.classify] tells it apart (RATE_LIMIT rather than BOT_CHECK).
 */
internal class RateLimitedException(url: String) :
    ReCaptchaException("Rate limited by YouTube (HTTP 429)", url)
