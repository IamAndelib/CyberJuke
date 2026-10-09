package io.github.iamandelib.cyberjuke.bridge

import com.getcapacitor.PluginCall

// Number arguments from JS: they arrive as Integer, Long or Double, and PluginCall.getInt and
// getLong are type-strict.

internal fun PluginCall.numArg(key: String): Number? {
    val data = data
    if (!data.has(key) || data.isNull(key)) return null
    return data.opt(key) as? Number
}

internal fun PluginCall.intArg(key: String): Int? = numArg(key)?.toInt()

internal fun PluginCall.longArg(key: String): Long? = numArg(key)?.toLong()
