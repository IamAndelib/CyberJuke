package io.github.iamandelib.cyberjuke.yt

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
