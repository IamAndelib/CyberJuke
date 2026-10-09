package io.github.iamandelib.cyberjuke.yt

import io.github.iamandelib.cyberjuke.findCause
import io.github.iamandelib.cyberjuke.net.BlockedException
import io.github.iamandelib.cyberjuke.net.FailureKind
import org.schabi.newpipe.extractor.MediaFormat
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.exceptions.AgeRestrictedContentException
import org.schabi.newpipe.extractor.exceptions.ContentNotAvailableException
import org.schabi.newpipe.extractor.exceptions.ExtractionException
import org.schabi.newpipe.extractor.exceptions.GeographicRestrictionException
import org.schabi.newpipe.extractor.exceptions.PaidContentException
import org.schabi.newpipe.extractor.exceptions.ParsingException
import org.schabi.newpipe.extractor.exceptions.PrivateContentException
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import org.schabi.newpipe.extractor.exceptions.SignInConfirmNotBotException
import org.schabi.newpipe.extractor.services.youtube.YoutubeParsingHelper
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.AudioTrackType
import org.schabi.newpipe.extractor.stream.DeliveryMethod
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.stream.VideoStream
import java.io.IOException

/**
 * The ONLY file that touches the NewPipeExtractor stream API (checked against commit
 * 65cabc2ba5216ee871ace4a9963c08bdbf5d5dc0, which only asks YouTube's visionOS client for
 * streams: the ANDROID, iOS and WEB_EMBEDDED_PLAYER clients were removed upstream, PR #1529).
 * If a NewPipeExtractor bump breaks compilation, the fix should be confined to this file (and
 * [LeanRequests], which knows which of the extractor's requests streams don't need).
 */
internal object YtCompat {

    /** Plain data the rest of the player uses, independent of NewPipe types. */
    data class Candidate(
        val url: String,
        val itag: Int,             // YouTube format id; -1 if unknown
        val bitrate: Int,          // bits per second-ish; -1 if unknown
        val mimeType: String?,     // e.g. audio/mp4, audio/webm
        val originalTrack: Boolean, // false for dubbed/descriptive audio tracks
    )

    data class Extracted(
        val audio: List<Candidate>,
        val muxed: List<Candidate>,
        val hlsUrl: String?,
        val durationSec: Long,
    )

    @Volatile private var initialized = false

    @Synchronized
    fun ensureInit() {
        if (initialized) return
        NewPipe.init(DownloaderImpl.get())
        initialized = true
    }

    /** Use the lean path ([extractLean]) first. Off only in tests of the full path. */
    @Volatile
    var lean = true

    /** Why the lean path last fell back to the full one (diagnostics, the canary). */
    @Volatile
    var lastLeanFallback: String? = null
        private set

    /**
     * Blocking network call. Never call on the main thread. The lean path first; anything
     * unexpected there (a parse failure, no streams) falls back to the full StreamInfo
     * extraction. YouTube's own answers (blocked, gone, offline) are final: the full path
     * would hear the same, with more requests.
     */
    fun extract(ytId: String): Extracted {
        ensureInit()
        if (lean) {
            try {
                return extractLean(ytId)
            } catch (e: Exception) {
                val kind = classify(e)
                if (kind != FailureKind.BROKEN && kind != FailureKind.OTHER) throw e
                lastLeanFallback = "${e.javaClass.simpleName}: ${e.message}"
            }
        }
        return extractFull(ytId)
    }

    /**
     * Only the requests streams come from: the visionOS client's visitor id and player
     * response (2 requests instead of 5). The extractor's own code does the work, with the WEB
     * metadata and `next` requests (title, thumbnails, related videos: unused here) answered
     * locally by [DownloaderImpl] ([LeanRequests]). Throttling parameters are decoded by the
     * extractor as usual.
     */
    fun extractLean(ytId: String): Extracted {
        ensureInit()
        val extractor = ServiceList.YouTube.getStreamExtractor(watchUrl(ytId))
        LeanRequests.during { extractor.fetchPage() }
        val out = Extracted(
            audio = audioCandidates(extractor.audioStreams),
            muxed = muxedCandidates(extractor.videoStreams),
            hlsUrl = extractor.hlsUrl.takeIf { it.isNotBlank() },
            durationSec = extractor.length,
        )
        if (out.audio.isEmpty() && out.muxed.isEmpty() && out.hlsUrl == null) {
            throw ParsingException("lean: no streams in the player response")
        }
        return out
    }

    /** NewPipe's full extraction (every request StreamInfo makes). */
    fun extractFull(ytId: String): Extracted {
        ensureInit()
        val info = StreamInfo.getInfo(ServiceList.YouTube, watchUrl(ytId))
        return Extracted(
            audio = audioCandidates(info.audioStreams),
            muxed = muxedCandidates(info.videoStreams),
            hlsUrl = info.hlsUrl?.takeIf { it.isNotBlank() },
            durationSec = info.duration,
        )
    }

    private fun watchUrl(ytId: String) = "https://www.youtube.com/watch?v=$ytId"

    private fun audioCandidates(streams: List<AudioStream>): List<Candidate> = streams
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
                originalTrack = it.audioTrackType == null ||
                    it.audioTrackType == AudioTrackType.ORIGINAL,
            )
        }

    private fun muxedCandidates(streams: List<VideoStream>): List<Candidate> = streams
        .filter { it.deliveryMethod == DeliveryMethod.PROGRESSIVE_HTTP && it.isUrl && !it.isVideoOnly() }
        .map {
            Candidate(
                url = it.content,
                itag = it.itag,
                // Rank muxed streams by height: lowest first is what we want.
                bitrate = it.height,
                mimeType = it.format?.mimeType,
                originalTrack = true,
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
        is BlockedException -> "BOT_CHECK: YouTube back-off running (${t.reason})"
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
        // YouTube swaps in another video's player response when it rate-limits an IP (the
        // extractor's own note on isPlayerResponseNotValid): a limit, not a broken parser.
        is ExtractionException -> when {
            t.cause?.findCause<IOException>() != null -> FailureKind.NETWORK
            isSwappedPlayerResponse(t) -> FailureKind.RATE_LIMIT
            else -> FailureKind.BROKEN
        }
        else -> if (t.cause?.findCause<IOException>() != null) FailureKind.NETWORK else FailureKind.OTHER
    }

    private fun isSwappedPlayerResponse(t: Throwable): Boolean =
        t.message?.contains("player response is not valid", ignoreCase = true) == true

    private fun isTryAgainLater(t: Throwable): Boolean =
        t.message?.contains("try again later", ignoreCase = true) == true
}

/**
 * HTTP 429 from YouTube, thrown by [DownloaderImpl]. A [ReCaptchaException] so NewPipe treats
 * it like before; [YtCompat.classify] tells it apart (RATE_LIMIT rather than BOT_CHECK).
 */
internal class RateLimitedException(url: String) :
    ReCaptchaException("Rate limited by YouTube (HTTP 429)", url)
