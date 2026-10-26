package io.github.iamandelib.cyberjuke.playback

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.SessionCommand
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Custom URI scheme for queue items. The real stream URL is resolved lazily at load time:
 * `cyberjuke://yt/<ytId>` for a YouTube video, `cyberjuke://mp3/<file>` for a Jukebox MP3,
 * whose one possible URL ([mp3UrlOf]) is rebuilt from its latex.gg file name.
 */
internal object JukeUris {
    const val SCHEME = "cyberjuke"
    private const val HOST_YT = "yt"
    private const val HOST_MP3 = "mp3"
    const val EXTRA_YT_ID = "ytId"
    /** A Jukebox MP3's latex.gg link, in its metadata extras (the last session and `tracks` echo it). */
    const val EXTRA_MP3 = "mp3"

    fun forYt(ytId: String): Uri = Uri.parse("$SCHEME://$HOST_YT/${Uri.encode(ytId)}")

    /** Null unless [url] is a Jukebox MP3 link ([SessionPolicy.isValidMp3Url]). */
    fun forMp3(url: String): Uri? = SessionPolicy.mp3FileOf(url)?.let { Uri.parse("$SCHEME://$HOST_MP3/$it") }

    fun ytIdOf(uri: Uri?): String? {
        if (uri == null || uri.scheme != SCHEME || uri.host != HOST_YT) return null
        return uri.lastPathSegment?.takeIf { it.isNotEmpty() }
    }

    /** The latex.gg URL of a `cyberjuke://mp3/<file>` URI, or null for any other URI. */
    fun mp3UrlOf(uri: Uri?): String? {
        if (uri == null || uri.scheme != SCHEME || uri.host != HOST_MP3) return null
        return SessionPolicy.mp3UrlForFile(uri.lastPathSegment)
    }

    /** The item is a Jukebox MP3 (its URI, or on a controller, which gets no URI, its metadata). */
    fun isMp3(item: MediaItem?): Boolean = mp3UrlOf(item) != null

    /** The item's MP3 link: from its URI, else the metadata extra (a restored item). */
    fun mp3UrlOf(item: MediaItem?): String? {
        if (item == null) return null
        return mp3UrlOf(item.localConfiguration?.uri)
            ?: item.mediaMetadata.extras?.getString(EXTRA_MP3)?.takeIf { SessionPolicy.isValidMp3Url(it) }
    }

    /** ytId from the URI, falling back to the metadata extras. */
    fun ytIdOf(item: MediaItem?): String? {
        if (item == null) return null
        return ytIdOf(item.localConfiguration?.uri)
            ?: item.mediaMetadata.extras?.getString(EXTRA_YT_ID)
    }
}

/**
 * Per-track data the web gave us that other apps must not see (S1): the poster (`by`) and the
 * post URL. MediaMetadata extras are readable by every connected controller, so these live
 * here, keyed by mediaId, instead. Read back for the last session and the `tracks` event
 * (membersOnly must survive both, or a sign-out could miss a restored members-only track).
 */
internal object TrackExtras {
    /** [restored]: from the last session, not (yet) from the page, which may not know it. */
    data class Extra(val by: String?, val postUrl: String?, val membersOnly: Boolean = false, val restored: Boolean = false)

    /** A bounded LRU, far above what one session holds (a 2000-track list, plus queued and autoplay tracks). */
    private const val MAX = 20_000
    private val map = object : LinkedHashMap<String, Extra>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Extra>?) = size > MAX
    }

    fun put(mediaId: String, by: String?, postUrl: String?, membersOnly: Boolean = false, restored: Boolean = false) {
        synchronized(map) {
            if (by == null && postUrl == null && !membersOnly && !restored) {
                map.remove(mediaId)
            } else {
                map[mediaId] = Extra(by, postUrl, membersOnly, restored)
            }
        }
    }

    fun get(mediaId: String): Extra? = synchronized(map) { map[mediaId] }
}

/** A bridge call over a size cap (K6): rejected with code TOO_LARGE. */
internal class TooLargeException(message: String) : IllegalArgumentException(message)

/**
 * Size caps on what the bridge accepts (K6): at most [MAX_ITEMS] tracks or ids per call and
 * [MAX_STRING] characters per string. Pure (BridgeLimitsTest).
 */
internal object BridgeLimits {
    const val MAX_ITEMS = 2000
    const val MAX_STRING = 2000

    fun checkCount(n: Int, what: String) {
        if (n > MAX_ITEMS) throw TooLargeException("TOO_LARGE: $n $what (max $MAX_ITEMS)")
    }

    fun checkString(s: String?, what: String): String? {
        if (s != null && s.length > MAX_STRING) {
            throw TooLargeException("TOO_LARGE: $what is ${s.length} characters (max $MAX_STRING)")
        }
        return s
    }

    /** The track count and every string value of a NativeTrack[] JSON array. */
    fun checkTracks(arr: JSONArray?) {
        if (arr == null) return
        checkCount(arr.length(), "tracks")
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            for (key in o.keys()) {
                val v = o.opt(key)
                if (v is String) checkString(v, "track.$key")
            }
        }
    }

    /** A string array (ids): count and lengths. Non-strings are an error. */
    fun idsOf(arr: JSONArray?): List<String> {
        if (arr == null) return emptyList()
        checkCount(arr.length(), "ids")
        return (0 until arr.length()).map { i ->
            val v = arr.opt(i) as? String ?: throw IllegalArgumentException("ids[$i] is not a string")
            checkString(v, "ids[$i]")!!
        }
    }
}

/** NativeTrack JSON (the TS contract) to MediaItems; used by the plugin and the service. */
internal object JukeTracks {
    /** Throws [TooLargeException] over the caps, IllegalArgumentException on a bad track. */
    fun parse(arr: JSONArray?): List<MediaItem> {
        if (arr == null) return emptyList()
        BridgeLimits.checkTracks(arr)
        val items = ArrayList<MediaItem>(arr.length())
        for (i in 0 until arr.length()) {
            items.add(toMediaItem(arr.getJSONObject(i)))
        }
        return items
    }

    /**
     * [restored]: a track of the last session (see [TrackExtras.Extra.restored]). A track plays
     * a YouTube video (`ytId`) or, with `ytId` "", a Jukebox MP3 (`mp3`, a latex.gg link).
     */
    fun toMediaItem(o: JSONObject, restored: Boolean = false): MediaItem {
        val id = o.str("id") ?: throw IllegalArgumentException("track.id missing")
        val ytId = o.str("ytId")
        val mp3 = o.str("mp3")
        val uri = when {
            ytId != null && SessionPolicy.isValidYtId(ytId) -> JukeUris.forYt(ytId)
            ytId == null && mp3 != null -> JukeUris.forMp3(mp3) ?: throw IllegalArgumentException("track.mp3 invalid ($id)")
            ytId == null -> throw IllegalArgumentException("track.ytId missing ($id)")
            else -> throw IllegalArgumentException("track.ytId invalid ($id)")
        }
        val membersOnly = o.optBoolean("membersOnly", false)
        TrackExtras.put(id, o.str("by"), o.str("postUrl"), membersOnly, restored)
        // Its audio is tagged in the listening cache, so a sign-out removes it.
        if (membersOnly && ytId != null) AudioCache.markMembers(listOf(ytId))
        val extras = Bundle().apply {
            if (ytId != null) putString(JukeUris.EXTRA_YT_ID, ytId) else putString(JukeUris.EXTRA_MP3, mp3)
        }
        val metadata = MediaMetadata.Builder()
            .setTitle(o.str("title"))
            .setArtist(o.str("artist"))
            // The album it was opened from, if any: Crossfade leaves two tracks of one album alone.
            // Read back for the last session and the `tracks` event, so the rule survives a restart.
            .setAlbumTitle(o.str("album"))
            .setArtworkUri(o.str("artworkUrl")?.takeIf { SessionPolicy.isAllowedArtwork(it) }?.let { Uri.parse(it) })
            .setExtras(extras)
            .build()
        return MediaItem.Builder()
            .setMediaId(id)
            .setUri(uri)
            .setMediaMetadata(metadata)
            .build()
    }

    private fun JSONObject.str(key: String): String? =
        if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }
}

/**
 * Identifies the JukePlayer plugin's MediaController to PlaybackService (S1): a random token,
 * made once per process, sent in the controller's connection hints. Both live in the app
 * process, so nothing outside it ever sees the token; the service grants the private queue
 * commands only to a controller that presents it ([SessionPolicy.grant]).
 */
internal object ControllerKey {
    const val HINT = "io.github.iamandelib.cyberjuke.CONTROLLER_KEY"

    val token: String by lazy {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        bytes.joinToString("") { "%02x".format(it) }
    }

    /** Connection hints for the plugin's MediaController.Builder. */
    fun hints(): Bundle = Bundle().apply { putString(HINT, token) }

    fun of(hints: Bundle?): String? = hints?.getString(HINT)
}

/**
 * In-process bridge from PlaybackService to JukePlayerPlugin (both live in the app process).
 * Listeners are invoked on the main thread.
 */
internal object PlayerBus {
    /**
     * [network]: the connection failed, not the track (the web says so instead of naming the
     * track); [resumes]: playback picks up by itself once the network is back.
     */
    fun interface TrackErrorListener {
        fun onTrackError(trackId: String, message: String, skipped: Boolean, network: Boolean, resumes: Boolean)
    }

    /** NewPipe could not parse YouTube's answer (YouTube changed something). Any thread. */
    fun interface ExtractorBrokenListener {
        fun onExtractorBroken(message: String)
    }

    private val listeners = CopyOnWriteArraySet<TrackErrorListener>()
    private val brokenListeners = CopyOnWriteArraySet<ExtractorBrokenListener>()

    fun add(l: TrackErrorListener) {
        listeners.add(l)
    }

    fun remove(l: TrackErrorListener) {
        listeners.remove(l)
    }

    fun addBroken(l: ExtractorBrokenListener) {
        brokenListeners.add(l)
    }

    fun removeBroken(l: ExtractorBrokenListener) {
        brokenListeners.remove(l)
    }

    fun emitTrackError(trackId: String, message: String, skipped: Boolean, network: Boolean = false, resumes: Boolean = false) {
        listeners.forEach { it.onTrackError(trackId, message, skipped, network, resumes) }
    }

    fun emitExtractorBroken(message: String) {
        brokenListeners.forEach { it.onExtractorBroken(message) }
    }
}
