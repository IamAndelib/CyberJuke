package io.github.iamandelib.cyberjuke.player

import android.content.Intent
import android.net.Uri
import androidx.media3.common.MediaItem
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
