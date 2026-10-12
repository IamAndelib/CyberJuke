package io.github.iamandelib.cyberjuke.playback

import android.content.Context

/**
 * The page's player settings (Autoplay, audio quality), kept here too (SharedPreferences
 * [PREFS], beside [NetPrefsStore]) and read when the service starts: it can start, and play,
 * before the page has loaded to send them.
 */
internal object PlayerPrefsStore {
    /** The native side's SharedPreferences file (also [NetPrefsStore]'s). */
    const val PREFS = "cyberjuke_player"
    private const val KEY_AUTOPLAY = "autoplay"
    private const val KEY_QUALITY = "quality"

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun autoplay(context: Context): Boolean = prefs(context).getBoolean(KEY_AUTOPLAY, true)

    fun setAutoplay(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_AUTOPLAY, enabled).apply()
    }

    /** Nothing saved yet, or something unknown: Auto. */
    fun quality(context: Context): AudioQuality = AudioQuality.of(prefs(context).getString(KEY_QUALITY, null))

    fun setQuality(context: Context, quality: AudioQuality) {
        prefs(context).edit().putString(KEY_QUALITY, quality.key).apply()
    }
}
