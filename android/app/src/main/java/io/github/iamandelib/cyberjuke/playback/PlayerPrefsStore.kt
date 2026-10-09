package io.github.iamandelib.cyberjuke.playback

import android.content.Context

/**
 * The page's player settings (Autoplay, audio quality), kept here too (SharedPreferences
 * "cyberjuke_player", beside [NetPrefsStore]): after Android stopped the app, a media key or
 * Bluetooth resumes the last session before the page has loaded to send them.
 */
internal object PlayerPrefsStore {
    private const val PREFS = "cyberjuke_player"
    private const val KEY_AUTOPLAY = "autoplay"
    private const val KEY_QUALITY = "quality"

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun autoplay(context: Context): Boolean = prefs(context).getBoolean(KEY_AUTOPLAY, true)

    fun setAutoplay(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_AUTOPLAY, enabled).apply()
    }

    fun quality(context: Context): StreamResolver.Quality =
        if (prefs(context).getString(KEY_QUALITY, null) == "low") StreamResolver.Quality.LOW else StreamResolver.Quality.HIGH

    fun setQuality(context: Context, quality: StreamResolver.Quality) {
        prefs(context).edit().putString(KEY_QUALITY, if (quality == StreamResolver.Quality.LOW) "low" else "high").apply()
    }
}
