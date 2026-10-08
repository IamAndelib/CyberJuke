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
    const val CI_TONE_ASSET = "asset:///ci-tone.ogg"

    @Volatile
    @JvmStatic
    var ciToneConsumed = false
}
