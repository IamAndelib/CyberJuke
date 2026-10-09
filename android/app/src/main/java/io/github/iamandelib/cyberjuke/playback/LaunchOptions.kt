package io.github.iamandelib.cyberjuke.playback

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo

internal fun Context.isDebuggable(): Boolean =
    (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

/** Launch options from the activity intent (`--es autoplay latest`, debuggable builds), read by getLaunchOptions(). */
object LaunchOptions {
    @Volatile
    @JvmStatic
    var autoplay: String? = null

    /** The `autoplay` extra is a CI hook: honoured on debuggable builds only (S2). */
    @JvmStatic
    fun updateFrom(context: Context, intent: Intent?) {
        autoplay = if (context.isDebuggable()) {
            intent?.getStringExtra("autoplay")?.takeIf { it == "latest" || it == CI_TONE }
        } else {
            null
        }
        ciToneConsumed = false
    }

    /**
     * CI only: `--es autoplay ci-tone` makes the plugin queue a bundled test tone directly,
     * so the playback service, media session and background playback can be verified on
     * runners whose IPs YouTube blocks. The asset only exists in debug builds
     * (src/debug/assets), so in release this id just fails to load.
     */
    const val CI_TONE = "ci-tone"

    /** The media notification's tap: the app opens on Now Playing. */
    const val ACTION_NOW_PLAYING = "io.github.iamandelib.cyberjuke.NOW_PLAYING"

    /**
     * [intent] is the notification's tap, as it happened (not the same intent replayed when the
     * app is reopened from Recents after Android stopped it).
     */
    @JvmStatic
    fun opensNowPlaying(intent: Intent?): Boolean = intent?.action == ACTION_NOW_PLAYING &&
        (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0

    /**
     * CI only (debuggable builds): `--es ci_renderer kill` (as when Android reclaims its memory)
     * or `crash` ends the WebView's renderer; the URL that does it, else null.
     */
    @JvmStatic
    fun ciRendererUrl(context: Context, intent: Intent?): String? {
        if (!context.isDebuggable()) return null
        return when (intent?.getStringExtra("ci_renderer")) {
            "kill" -> "chrome://kill"
            "crash" -> "chrome://crash"
            else -> null
        }
    }
    const val CI_TONE_ASSET = "asset:///ci-tone.ogg"

    @Volatile
    @JvmStatic
    var ciToneConsumed = false
}
