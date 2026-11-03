package io.github.iamandelib.cyberjuke.yt

import io.github.iamandelib.cyberjuke.playback.BridgeLimits
import org.json.JSONArray
import org.json.JSONObject
import java.text.Normalizer

/**
 * Pure text helpers for the music feature (no Android types; unit-tested in MusicTextTest).
 */
internal object MusicText {

    private val CHANNEL_RE = Regex("""/channel/(UC[A-Za-z0-9_-]{10,})(?:[/?#]|$)""")

    /**
     * YouTube channel id ("UC…") from a channel URL such as
     * `https://www.youtube.com/channel/UCiMhD4jzUqG-IgPzUmmytRQ` (also music.youtube.com,
     * trailing `/videos`, `?si=…`). Null for null, @handle, /user/ or /c/ URLs, which don't
     * carry the id.
     */
    fun channelIdOf(url: String?): String? {
        if (url.isNullOrBlank()) return null
        return CHANNEL_RE.find(url)?.groupValues?.get(1)
    }

    /** Most artists one song keeps (a long credit beyond this is still shown whole). */
    const val MAX_CREDITS = 10

    private val CHANNEL_ID = Regex("""UC[A-Za-z0-9_-]{10,}""")
    private val TOPIC = Regex("""\s+-\s+Topic$""", RegexOption.IGNORE_CASE)

    /**
     * The artists in a byline's runs, as YouTube Music links them: each run whose browse
     * endpoint is a `UC…` channel, once per channel, in order. Separators (", ", " & ") and
     * albums (`MPREb_…`) have none, so they never count; an artist without a link is left out.
     */
    fun artistsOf(runs: JSONArray?): List<YtMusic.Credit> {
        val out = ArrayList<YtMusic.Credit>()
        for (i in 0 until (runs?.length() ?: 0)) {
            val run = runs!!.optJSONObject(i) ?: continue
            val id = run.optJSONObject("navigationEndpoint")?.optJSONObject("browseEndpoint")?.optString("browseId")
            creditOrNull(run.optString("text"), id)?.let { c -> if (out.none { it.channelId == c.channelId }) out.add(c) }
            if (out.size == MAX_CREDITS) break
        }
        return out
    }

    /** NewPipe's uploader as the one credited artist, when its URL names a channel. */
    fun creditOf(name: String?, url: String?): List<YtMusic.Credit> = listOfNotNull(creditOrNull(name, channelIdOf(url)))

    /** NativeTrack `artists` (JSON) back to credits: invalid entries dropped, at most [MAX_CREDITS]. */
    fun creditsOf(arr: JSONArray?): List<YtMusic.Credit> {
        val out = ArrayList<YtMusic.Credit>()
        for (i in 0 until (arr?.length() ?: 0)) {
            val o = arr!!.opt(i) as? JSONObject ?: continue
            creditOrNull(o.opt("name") as? String, o.opt("channelId") as? String)?.let { out.add(it) }
            if (out.size == MAX_CREDITS) break
        }
        return out
    }

    /** Credits as NativeTrack / MusicItem `artists`: `[{ name, channelId }]`. */
    fun creditsJson(credits: List<YtMusic.Credit>): JSONArray =
        JSONArray().apply { credits.forEach { put(JSONObject().put("name", it.name).put("channelId", it.channelId)) } }

    private fun creditOrNull(name: String?, channelId: String?): YtMusic.Credit? {
        val n = name?.replace(TOPIC, "")?.trim()
        if (n.isNullOrEmpty() || n.length > BridgeLimits.MAX_STRING) return null
        if (channelId == null || !CHANNEL_ID.matches(channelId)) return null
        return YtMusic.Credit(n, channelId)
    }

    /**
     * Comparable form of an artist name: accents removed (Beyoncé = Beyonce), lower case,
     * punctuation dropped, spaces collapsed. Letters of any script are kept, so non-Latin
     * names still compare.
     */
    fun normalize(s: String): String {
        val decomposed = Normalizer.normalize(s, Normalizer.Form.NFD)
        return decomposed
            .replace(Regex("""\p{M}+"""), "")
            .lowercase()
            .replace(Regex("""[^\p{L}\p{N}]+"""), " ")
            .trim()
    }

    private val CREDIT_SPLIT = Regex(
        """\s*(?:,|;|/|&|\+|\s+x\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+vs\.?\s+)\s*""",
        RegexOption.IGNORE_CASE,
    )

    /**
     * The names in an artist credit ("Queen & David Bowie" -> [queen, david bowie]),
     * normalized. The whole credit is included too, so "Simon & Garfunkel" also matches as
     * one name. " and " / " with " are not separators ("Florence and the Machine").
     */
    fun creditNames(credit: String): Set<String> {
        val out = LinkedHashSet<String>()
        normalize(credit).takeIf { it.isNotEmpty() }?.let { out.add(it) }
        for (part in credit.split(CREDIT_SPLIT)) {
            val n = normalize(part)
            if (n.isNotEmpty()) out.add(n)
        }
        return out
    }

    /**
     * True when two credits share a name exactly ("Queen" vs "Queen & David Bowie"), never
     * by substring ("Queen" vs "Ivy Queen" is false).
     */
    fun creditsOverlap(a: String, b: String): Boolean {
        val x = creditNames(a)
        if (x.isEmpty()) return false
        return creditNames(b).any { it in x }
    }
}
