package io.github.iamandelib.cyberjuke.player

import android.content.Context

/** Persists [NetPrefs] (SharedPreferences "cyberjuke_player"); applied at service start. */
internal object NetPrefsStore {
    private const val PREFS = "cyberjuke_player"
    private const val KEY_PREFER_IPV4 = "prefer_ipv4"

    fun load(context: Context) {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (NetPrefs.setPreferIpv4(prefs.getBoolean(KEY_PREFER_IPV4, false))) StreamResolver.clear()
    }

    fun setPreferIpv4(context: Context, value: Boolean) {
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_PREFER_IPV4, value).apply()
        if (NetPrefs.setPreferIpv4(value)) StreamResolver.clear()
    }
}
