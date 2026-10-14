package io.github.iamandelib.cyberjuke.playback

import android.content.Context

/**
 * The page's player settings (Autoplay, audio quality, the listening cache's size, Crossfade),
 * kept here too (SharedPreferences [PREFS], beside [NetPrefsStore]) and read when the service
 * starts: it can start, and play, before the page has loaded to send them.
 */
internal object PlayerPrefsStore {
    /** The native side's SharedPreferences file (also [NetPrefsStore]'s). */
    const val PREFS = "cyberjuke_player"
    private const val KEY_AUTOPLAY = "autoplay"
    private const val KEY_QUALITY = "quality"
    private const val KEY_CACHE_MB = "cacheMb"
    private const val KEY_CROSSFADE_MS = "crossfadeMs"

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

    /** The listening cache's size in MB; nothing saved yet, or something unknown: the default. */
    fun cacheMb(context: Context): Int = AudioCache.sizeOf(prefs(context).getInt(KEY_CACHE_MB, AudioCache.DEFAULT_MB))

    fun setCacheMb(context: Context, mb: Int) {
        prefs(context).edit().putInt(KEY_CACHE_MB, AudioCache.sizeOf(mb)).apply()
    }

    /** The crossfade in ms, 0 for Off (the default, and anything unknown). */
    fun crossfadeMs(context: Context): Int = CrossfadePlan.valid(prefs(context).getInt(KEY_CROSSFADE_MS, 0)) ?: 0

    fun setCrossfadeMs(context: Context, ms: Int) {
        prefs(context).edit().putInt(KEY_CROSSFADE_MS, CrossfadePlan.valid(ms) ?: 0).apply()
    }
}
