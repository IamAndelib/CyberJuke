package io.github.iamandelib.cyberjuke.player

import android.content.Context
import android.util.Log
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.schabi.newpipe.extractor.services.youtube.YoutubeParsingHelper
import java.io.IOException
import java.nio.charset.StandardCharsets

/**
 * Lyrics lookup: LRCLIB first (open, time-synced), then YouTube Music's own lyrics tab via
 * InnerTube (`next` -> MPLYt… browse id -> `browse`). Blocking network calls: call them on
 * the plugin's single lyrics thread only, so requests go one at a time (LRCLIB rate-limits).
 *
 * Errors: an IOException (incl. LRCLIB HTTP 429/5xx), NewPipe's ReCaptchaException
 * (HTTP 429 from YouTube) or another exception is thrown only when no source found lyrics
 * AND a source failed, so a "not found" is never cached because of an outage.
 */
internal object Lyrics {
    private const val TAG = "CyberJukeLyrics"
    private const val LRCLIB = "https://lrclib.net/api"
    private const val YTM = "https://music.youtube.com/youtubei/v1"
    private const val DURATION_TOLERANCE_SEC = 3.0

    data class Result(
        val found: Boolean,
        val source: String? = null,
        val synced: List<Lrc.Line>? = null,
        val plain: String? = null,
        val instrumental: Boolean = false,
    )

    @Volatile
    private var userAgent = "CyberJuke (https://github.com/IamAndelib/CyberJuke)"

    /** `CyberJuke/<versionName> (https://github.com/IamAndelib/CyberJuke)`; idempotent. */
    fun init(context: Context) {
        val version = try {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
        } catch (_: Exception) {
            null
        }
        userAgent = "CyberJuke/${version ?: "dev"} (https://github.com/IamAndelib/CyberJuke)"
    }

    /**
     * @param ytId used for the YouTube Music fallback; blank skips it.
     * @param durationSec the track length; LRCLIB matches must be within ±3 s of it.
     */
    fun fetch(ytId: String?, title: String, artist: String, album: String?, durationSec: Double?): Result {
        var failure: Throwable? = null
        try {
            lrclib(title, artist, album, durationSec)?.let { return it }
        } catch (t: Throwable) {
            Log.w(TAG, "LRCLIB failed: ${t.message}")
            failure = t
        }
        if (!ytId.isNullOrBlank()) {
            try {
                ytMusic(ytId)?.let { return it }
            } catch (t: Throwable) {
                Log.w(TAG, "YouTube Music lyrics failed: ${YtCompat.describe(t)}")
                // A YouTube bot check is the more useful reason to report.
                failure = t
            }
        }
        if (failure != null) throw failure
        return Result(found = false)
    }

    // ---- LRCLIB ---------------------------------------------------------------------------

    private fun lrclib(title: String, artist: String, album: String?, durationSec: Double?): Result? {
        val get = "$LRCLIB/get".toHttpUrl().newBuilder()
            .addQueryParameter("track_name", title)
            .addQueryParameter("artist_name", artist)
            .apply {
                if (!album.isNullOrBlank()) addQueryParameter("album_name", album)
                if (durationSec != null) addQueryParameter("duration", Math.round(durationSec).toString())
            }
            .build()
        lrclibGet(get.toString())?.let { body ->
            val e = entryOf(JSONObject(body))
            if (e.usable) return resultOf(e)
        }

        val search = "$LRCLIB/search".toHttpUrl().newBuilder()
            .addQueryParameter("track_name", title)
            .addQueryParameter("artist_name", artist)
            .build()
        val body = lrclibGet(search.toString()) ?: return null
        val arr = JSONArray(body)
        val entries = (0 until arr.length()).mapNotNull { i -> arr.optJSONObject(i)?.let(::entryOf) }
        return Lrc.pickBest(entries, artist, durationSec, DURATION_TOLERANCE_SEC)?.let(::resultOf)
    }

    /** Body on 200; null on 404/400 (not found / not enough data); IOException otherwise. */
    private fun lrclibGet(url: String): String? {
        val request = Request.Builder()
            .url(url)
            .header("User-Agent", userAgent)
            .header("Accept", "application/json")
            .build()
        Http.client.newCall(request).execute().use { response ->
            return when (response.code) {
                200 -> {
                    @Suppress("UNNECESSARY_SAFE_CALL", "USELESS_ELVIS")
                    response.body?.string() ?: ""
                }
                400, 404 -> null
                else -> throw IOException("LRCLIB HTTP ${response.code}")
            }
        }
    }

    private fun entryOf(o: JSONObject) = Lrc.LrclibEntry(
        trackName = o.optStringOrNull("trackName") ?: "",
        artistName = o.optStringOrNull("artistName") ?: "",
        durationSec = if (o.has("duration") && !o.isNull("duration")) o.optDouble("duration") else null,
        instrumental = o.optBoolean("instrumental", false),
        plain = o.optStringOrNull("plainLyrics"),
        synced = o.optStringOrNull("syncedLyrics"),
    )

    private fun resultOf(e: Lrc.LrclibEntry): Result {
        val synced = Lrc.parse(e.synced).takeIf { it.isNotEmpty() }
        val plain = e.plain?.takeIf { it.isNotBlank() }
            ?: synced?.joinToString("\n") { it.text }
        val instrumental = e.instrumental && synced == null && plain == null
        return Result(found = true, source = "LRCLIB", synced = synced, plain = plain, instrumental = instrumental)
    }

    // ---- YouTube Music (InnerTube, WEB_REMIX) -------------------------------------------

    private fun ytMusic(ytId: String): Result? {
        YtCompat.ensureInit()
        val next = innertube("next", JSONObject().put("videoId", ytId).put("isAudioOnly", true))
            ?: return null
        val browseId = findLyricsBrowseId(next) ?: return null
        val browse = innertube("browse", JSONObject().put("browseId", browseId)) ?: return null
        val shelf = findObject(browse, "musicDescriptionShelfRenderer") ?: return null
        val plain = textOf(shelf.optJSONObject("description"))?.takeIf { it.isNotBlank() } ?: return null
        val footer = textOf(shelf.optJSONObject("footer"))?.trim()?.takeIf { it.isNotEmpty() }
        return Result(found = true, source = footer, plain = plain)
    }

    /** POST /youtubei/v1/<endpoint>; parsed JSON on 200, null on 404, throws otherwise. */
    private fun innertube(endpoint: String, payload: JSONObject): JSONObject? {
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
        // DownloaderImpl adds the consent cookie and maps HTTP 429 to ReCaptchaException.
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

    /** The lyrics tab's browse id (MPLYt…): absent when YouTube Music has no lyrics. */
    private fun findLyricsBrowseId(root: Any?): String? {
        when (root) {
            is JSONObject -> {
                root.optJSONObject("browseEndpoint")?.optStringOrNull("browseId")
                    ?.takeIf { it.startsWith("MPLYt") }?.let { return it }
                for (key in root.keys()) findLyricsBrowseId(root.opt(key))?.let { return it }
            }
            is JSONArray -> for (i in 0 until root.length()) findLyricsBrowseId(root.opt(i))?.let { return it }
        }
        return null
    }

    /** First object stored under [key], depth-first (the response layout shifts over time). */
    private fun findObject(root: Any?, key: String): JSONObject? {
        when (root) {
            is JSONObject -> {
                root.optJSONObject(key)?.let { return it }
                for (k in root.keys()) findObject(root.opt(k), key)?.let { return it }
            }
            is JSONArray -> for (i in 0 until root.length()) findObject(root.opt(i), key)?.let { return it }
        }
        return null
    }

    /** InnerTube text: `{runs:[{text}]}` or `{simpleText}`. */
    private fun textOf(o: JSONObject?): String? {
        if (o == null) return null
        o.optStringOrNull("simpleText")?.let { return it }
        val runs = o.optJSONArray("runs") ?: return null
        val sb = StringBuilder()
        for (i in 0 until runs.length()) sb.append(runs.optJSONObject(i)?.optString("text") ?: "")
        return sb.toString()
    }

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (!has(key) || isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }
}
