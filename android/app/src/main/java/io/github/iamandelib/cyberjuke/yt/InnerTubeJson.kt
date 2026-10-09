package io.github.iamandelib.cyberjuke.yt

import org.json.JSONArray
import org.json.JSONObject

// Reading InnerTube (and LRCLIB) JSON: the layouts shift over time, so lookups search the tree
// rather than follow fixed paths.

/** A non-empty string under [key]; null when absent, null or not a string. */
internal fun JSONObject.optStr(key: String): String? =
    if (!has(key) || isNull(key)) null else (opt(key) as? String)?.takeIf { it.isNotEmpty() }

/** Every object stored under [key], depth-first in document order. */
internal fun findAll(root: Any?, key: String): List<JSONObject> {
    val out = ArrayList<JSONObject>()
    fun collect(node: Any?) {
        when (node) {
            is JSONObject -> {
                val keys = node.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    val v = node.opt(k)
                    if (k == key && v is JSONObject) out.add(v)
                    collect(v)
                }
            }
            is JSONArray -> for (i in 0 until node.length()) collect(node.opt(i))
        }
    }
    collect(root)
    return out
}

/** First object stored under [key], depth-first (direct child first). */
internal fun findFirst(root: Any?, key: String): JSONObject? {
    when (root) {
        is JSONObject -> {
            root.optJSONObject(key)?.let { return it }
            val keys = root.keys()
            while (keys.hasNext()) findFirst(root.opt(keys.next()), key)?.let { return it }
        }
        is JSONArray -> for (i in 0 until root.length()) findFirst(root.opt(i), key)?.let { return it }
    }
    return null
}

/** First array stored under [key], depth-first (direct child first). */
internal fun findFirstArray(root: Any?, key: String): JSONArray? {
    when (root) {
        is JSONObject -> {
            root.optJSONArray(key)?.let { return it }
            val keys = root.keys()
            while (keys.hasNext()) findFirstArray(root.opt(keys.next()), key)?.let { return it }
        }
        is JSONArray -> for (i in 0 until root.length()) findFirstArray(root.opt(i), key)?.let { return it }
    }
    return null
}

/** InnerTube text: `{runs:[{text}]}` or `{simpleText}`; null when absent or empty. */
internal fun textOf(o: JSONObject?): String? {
    if (o == null) return null
    o.optStr("simpleText")?.let { return it }
    val runs = o.optJSONArray("runs") ?: return null
    val sb = StringBuilder()
    for (i in 0 until runs.length()) sb.append(runs.optJSONObject(i)?.optString("text") ?: "")
    return sb.toString().takeIf { it.isNotEmpty() }
}

internal data class Thumbnail(val url: String, val height: Int)

/** A `thumbnails` array's entries (protocol-relative URLs made https), https only. */
internal fun thumbnailsOf(arr: JSONArray?): List<Thumbnail> {
    if (arr == null) return emptyList()
    return (0 until arr.length()).mapNotNull { i ->
        val o = arr.optJSONObject(i) ?: return@mapNotNull null
        val raw = o.optStr("url") ?: return@mapNotNull null
        val url = if (raw.startsWith("//")) "https:$raw" else raw
        if (url.startsWith("https://")) Thumbnail(url, o.optInt("height", 0)) else null
    }
}
