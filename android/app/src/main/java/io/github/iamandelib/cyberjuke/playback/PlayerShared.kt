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

/** Custom URI scheme for queue items. The real stream URL is resolved lazily at load time. */
internal object JukeUris {
    const val SCHEME = "cyberjuke"
    private const val HOST_YT = "yt"
    const val EXTRA_YT_ID = "ytId"

    fun forYt(ytId: String): Uri = Uri.parse("$SCHEME://$HOST_YT/${Uri.encode(ytId)}")

    fun ytIdOf(uri: Uri?): String? {
        if (uri == null || uri.scheme != SCHEME || uri.host != HOST_YT) return null
        return uri.lastPathSegment?.takeIf { it.isNotEmpty() }
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
 * here, keyed by mediaId, instead. Bounded LRU; nothing reads it back yet (the web keeps its
 * own copy), but native features that need them should use [get].
 */
internal object TrackExtras {
    /** [restored]: from the last session, not (yet) from the page, which may not know it. */
    data class Extra(val by: String?, val postUrl: String?, val membersOnly: Boolean = false, val restored: Boolean = false)

    private const val MAX = 2000
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

    /** [restored]: a track of the last session (see [TrackExtras.Extra.restored]). */
    fun toMediaItem(o: JSONObject, restored: Boolean = false): MediaItem {
        val id = o.str("id") ?: throw IllegalArgumentException("track.id missing")
        val ytId = o.str("ytId") ?: throw IllegalArgumentException("track.ytId missing ($id)")
        if (!SessionPolicy.isValidYtId(ytId)) throw IllegalArgumentException("track.ytId invalid ($id)")
        TrackExtras.put(id, o.str("by"), o.str("postUrl"), o.optBoolean("membersOnly", false), restored)
        val extras = Bundle().apply { putString(JukeUris.EXTRA_YT_ID, ytId) }
        val metadata = MediaMetadata.Builder()
            .setTitle(o.str("title"))
            .setArtist(o.str("artist"))
            .setArtworkUri(o.str("artworkUrl")?.takeIf { SessionPolicy.isAllowedArtwork(it) }?.let { Uri.parse(it) })
            .setExtras(extras)
            .build()
        return MediaItem.Builder()
            .setMediaId(id)
            .setUri(JukeUris.forYt(ytId))
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

/** Custom session commands between JukePlayerPlugin and PlaybackService. */
internal object JukeCommands {
    /**
     * queueNext: args [ARG_TRACKS] = the NativeTrack[] JSON. A custom command because the
     * shuffle order can only be set on the service's ExoPlayer, not through a MediaController.
     */
    const val ACTION_QUEUE_NEXT = "io.github.iamandelib.cyberjuke.QUEUE_NEXT"
    const val ARG_TRACKS = "tracks"

    val QUEUE_NEXT = SessionCommand(ACTION_QUEUE_NEXT, Bundle.EMPTY)

    /** MediaMetadata extra (Long) marking a user-queued item; unique per queueNext insert. */
    const val EXTRA_QUEUE_SERIAL = "cyberjukeQueueSerial"
}

/**
 * In-process bridge from PlaybackService to JukePlayerPlugin (both live in the app process).
 * Listeners are invoked on the main thread.
 */
internal object PlayerBus {
    fun interface TrackErrorListener {
        fun onTrackError(trackId: String, message: String, skipped: Boolean)
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

    fun emitTrackError(trackId: String, message: String, skipped: Boolean) {
        listeners.forEach { it.onTrackError(trackId, message, skipped) }
    }

    fun emitExtractorBroken(message: String) {
        brokenListeners.forEach { it.onExtractorBroken(message) }
    }
}
