package io.github.iamandelib.cyberjuke.playback

import android.content.Context
import io.github.iamandelib.cyberjuke.net.Ipv4Mode
import io.github.iamandelib.cyberjuke.net.NetPrefs

/**
 * Persists [NetPrefs] (SharedPreferences [PlayerPrefsStore.PREFS]): the IPv4 setting and the AUTO
 * memory (which kinds of network were switched to IPv4, until when). Loaded once, at service
 * or plugin start, before anything touches the network.
 */
internal object NetPrefsStore {
    /** Before 1.0.0 the setting was an on/off "Prefer IPv4": on is ALWAYS, off is the new AUTO. */
    private const val KEY_PREFER_IPV4 = "prefer_ipv4"
    private const val KEY_MODE = "ipv4_mode"
    private const val KEY_AUTO = "ipv4_auto"

    private var loaded = false

    @Synchronized
    fun load(context: Context) {
        if (loaded) return
        val prefs = context.applicationContext.getSharedPreferences(PlayerPrefsStore.PREFS, Context.MODE_PRIVATE)
        val mode = prefs.getString(KEY_MODE, null)?.let { runCatching { Ipv4Mode.valueOf(it) }.getOrNull() }
            ?: if (prefs.getBoolean(KEY_PREFER_IPV4, false)) Ipv4Mode.ALWAYS else Ipv4Mode.AUTO
        if (NetPrefs.load(mode, NetPrefs.decodeMemory(prefs.getString(KEY_AUTO, null)))) StreamResolver.clear()
        NetPrefs.onChange = { familyChanged ->
            // Cached stream URLs are bound to the old address.
            if (familyChanged) StreamResolver.clear()
            prefs.edit()
                .putString(KEY_MODE, NetPrefs.mode.name)
                .putString(KEY_AUTO, NetPrefs.encodeMemory(NetPrefs.memory()))
                .remove(KEY_PREFER_IPV4)
                .apply()
        }
        loaded = true
    }

    fun setMode(context: Context, mode: Ipv4Mode) {
        load(context)
        NetPrefs.setMode(mode)
    }
}
