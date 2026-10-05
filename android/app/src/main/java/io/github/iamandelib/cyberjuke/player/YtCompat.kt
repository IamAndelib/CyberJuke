package io.github.iamandelib.cyberjuke.player

import org.schabi.newpipe.extractor.MediaFormat
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.exceptions.AgeRestrictedContentException
import org.schabi.newpipe.extractor.exceptions.ContentNotAvailableException
import org.schabi.newpipe.extractor.exceptions.GeographicRestrictionException
import org.schabi.newpipe.extractor.exceptions.PaidContentException
import org.schabi.newpipe.extractor.exceptions.PrivateContentException
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import org.schabi.newpipe.extractor.exceptions.SignInConfirmNotBotException
import org.schabi.newpipe.extractor.services.youtube.YoutubeParsingHelper
import org.schabi.newpipe.extractor.stream.AudioTrackType
import org.schabi.newpipe.extractor.stream.DeliveryMethod
import org.schabi.newpipe.extractor.stream.StreamInfo

/**
 * The ONLY file that touches the NewPipeExtractor API (checked against tag v0.26.5).
 * If a NewPipeExtractor bump breaks compilation, the fix should be confined to this file.
 */
internal object YtCompat {

    /** Plain data the rest of the player uses, independent of NewPipe types. */
    data class Candidate(
        val url: String,
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
        is ReCaptchaException -> "BOT_CHECK: reCAPTCHA / HTTP 429 from YouTube: ${t.message}"
        is AgeRestrictedContentException -> "AGE_RESTRICTED: ${t.message}"
        is GeographicRestrictionException -> "GEO_BLOCKED: ${t.message}"
        is PrivateContentException -> "PRIVATE: ${t.message}"
        is PaidContentException -> "PAID: ${t.message}"
        is ContentNotAvailableException -> "UNAVAILABLE: ${t.message}"
        else -> "${t.javaClass.simpleName}: ${t.message}"
    }

    /** True if retrying the same video soon is pointless. */
    fun isPermanent(t: Throwable): Boolean =
        t is ContentNotAvailableException || t is SignInConfirmNotBotException
}
