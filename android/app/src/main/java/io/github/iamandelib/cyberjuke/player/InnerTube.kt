package io.github.iamandelib.cyberjuke.player

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.schabi.newpipe.extractor.services.youtube.YoutubeParsingHelper
import java.io.IOException
import java.nio.charset.StandardCharsets

/**
 * YouTube Music InnerTube requests (WEB_REMIX client), shared by the lyrics fallback and the
 * artist pages. Client version and headers come from NewPipe's [YoutubeParsingHelper]; the
 * request goes through [DownloaderImpl] (consent cookie; HTTP 429 -> ReCaptchaException).
 * Blocking: never call on the main thread.
 */
internal object InnerTube {
    private const val YTM = "https://music.youtube.com/youtubei/v1"

    /** POST /youtubei/v1/<endpoint>; parsed JSON on 200, null on 404, throws otherwise. */
    fun post(endpoint: String, payload: JSONObject): JSONObject? {
        YtCompat.ensureInit()
        val version = YoutubeParsingHelper.getYoutubeMusicClientVersion()
        val client = JSONObject()
            .put("clientName", "WEB_REMIX")
            .put("clientVersion", version)
            .put("hl", "en")
            .put("gl", "US")
            .put("platform", "DESKTOP")
            .put("utcOffsetMinutes", 0)
        val context = JSONObject()
            .put("client", client)
            .put("request", JSONObject().put("internalExperimentFlags", JSONArray()).put("useSsl", true))
            .put("user", JSONObject().put("lockedSafetyMode", false))
        payload.put("context", context)
        val url = "$YTM/$endpoint?${YoutubeParsingHelper.DISABLE_PRETTY_PRINT_PARAMETER}"
        val response = DownloaderImpl.get().postWithContentTypeJson(
            url,
            YoutubeParsingHelper.getYoutubeMusicHeaders(),
            payload.toString().toByteArray(StandardCharsets.UTF_8),
        )
        return when (response.responseCode()) {
            200 -> try {
                JSONObject(response.responseBody())
            } catch (e: JSONException) {
                throw IOException("YouTube Music $endpoint: invalid JSON", e)
            }
            404 -> null
            else -> throw IllegalStateException("YouTube Music $endpoint: HTTP ${response.responseCode()}")
        }
    }
}
