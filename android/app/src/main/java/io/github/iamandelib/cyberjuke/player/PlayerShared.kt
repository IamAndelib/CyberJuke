package io.github.iamandelib.cyberjuke.player

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.SessionCommand
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArraySet

/** Custom URI scheme for queue items. The real stream URL is resolved lazily at load time. */
internal object JukeUris {
    const val SCHEME = "cyberjuke"
    private const val HOST_YT = "yt"
    const val EXTRA_YT_ID = "ytId"
    const val EXTRA_BY = "by"
    const val EXTRA_POST_URL = "postUrl"

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

/** NativeTrack JSON (the TS contract) to MediaItems; used by the plugin and the service. */
internal object JukeTracks {
    fun parse(arr: JSONArray?): List<MediaItem> {
        if (arr == null) return emptyList()
        val items = ArrayList<MediaItem>(arr.length())
        for (i in 0 until arr.length()) {
            items.add(toMediaItem(arr.getJSONObject(i)))
        }
        return items
    }

    fun toMediaItem(o: JSONObject): MediaItem {
        val id = o.str("id") ?: throw IllegalArgumentException("track.id missing")
        val ytId = o.str("ytId") ?: throw IllegalArgumentException("track.ytId missing ($id)")
        val extras = Bundle().apply {
            putString(JukeUris.EXTRA_YT_ID, ytId)
            o.str("by")?.let { putString(JukeUris.EXTRA_BY, it) }
            o.str("postUrl")?.let { putString(JukeUris.EXTRA_POST_URL, it) }
        }
        val metadata = MediaMetadata.Builder()
            .setTitle(o.str("title"))
            .setArtist(o.str("artist"))
            .setArtworkUri(o.str("artworkUrl")?.let { Uri.parse(it) })
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

    private val listeners = CopyOnWriteArraySet<TrackErrorListener>()

    fun add(l: TrackErrorListener) {
        listeners.add(l)
    }

    fun remove(l: TrackErrorListener) {
        listeners.remove(l)
    }

    fun emitTrackError(trackId: String, message: String, skipped: Boolean) {
        listeners.forEach { it.onTrackError(trackId, message, skipped) }
    }
}

/** Launch options from the activity intent (`--es autoplay latest`), read by getLaunchOptions(). */
object LaunchOptions {
    @Volatile
    @JvmStatic
    var autoplay: String? = null

    @JvmStatic
    fun updateFrom(intent: Intent?) {
        autoplay = intent?.getStringExtra("autoplay")?.takeIf { it == "latest" || it == CI_TONE }
        ciToneConsumed = false
    }

    /**
     * CI only: `--es autoplay ci-tone` makes the plugin queue a bundled test tone directly,
     * so the playback service, media session and background playback can be verified on
     * runners whose IPs YouTube blocks. The asset only exists in debug builds
     * (src/debug/assets), so in release this id just fails to load.
     */
    const val CI_TONE = "ci-tone"
    const val CI_TONE_ASSET = "asset:///ci-tone.ogg"

    @Volatile
    @JvmStatic
    var ciToneConsumed = false
}
