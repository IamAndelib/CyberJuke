package io.github.iamandelib.cyberjuke.player

import org.json.JSONArray
import org.json.JSONObject
import org.schabi.newpipe.extractor.exceptions.ParsingException

/**
 * YouTube Music's own radio for a song (AP3): InnerTube `next` (WEB_REMIX) with
 * `playlistId: RDAMVM<videoId>`, then `next` with the continuation for more. Parsing only (no
 * network, no Android types), unit-tested in RadioTest against captured responses.
 *
 * Layout (2026-10):
 * - first page: `contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer
 *   .watchNextTabbedResultsRenderer.tabs[0].tabRenderer.content.musicQueueRenderer.content
 *   .playlistPanelRenderer`;
 * - later pages: `continuationContents.playlistPanelContinuation`.
 * Both hold `contents[]` of `playlistPanelVideoRenderer` (or `playlistPanelVideoWrapperRenderer`
 * .primaryRenderer, when a song has a video counterpart) and
 * `continuations[0].nextRadioContinuationData.continuation`.
 */
internal object Radio {

    data class Page(val items: List<YtMusic.Item>, val next: String?)

    /** The `next` payload for the first page of [videoId]'s radio, or for a continuation. */
    fun payload(videoId: String, continuation: String?): JSONObject {
        val o = JSONObject().put("enablePersistentPlaylistPanel", true).put("isAudioOnly", true)
        return if (continuation != null) {
            o.put("continuation", continuation)
        } else {
            o.put("videoId", videoId).put("playlistId", "RDAMVM$videoId")
        }
    }

    /**
     * The radio's songs (without [skipId], the seed itself) and the continuation. Throws
     * [ParsingException] when no playlist panel is found: YouTube changed the layout.
     */
    fun parse(root: JSONObject, skipId: String?): Page {
        val panel = ArtistPage.findFirst(root.optJSONObject("continuationContents"), "playlistPanelContinuation")
            ?: ArtistPage.findFirst(root.optJSONObject("contents"), "playlistPanelRenderer")
            ?: throw ParsingException("radio: no playlist panel in the response")
        val out = ArrayList<YtMusic.Item>()
        val seen = HashSet<String>()
        val contents = panel.optJSONArray("contents") ?: JSONArray()
        for (i in 0 until contents.length()) {
            val c = contents.optJSONObject(i) ?: continue
            val r = c.optJSONObject("playlistPanelVideoRenderer")
                ?: c.optJSONObject("playlistPanelVideoWrapperRenderer")?.optJSONObject("primaryRenderer")
                    ?.optJSONObject("playlistPanelVideoRenderer")
                ?: continue
            val item = itemOf(r) ?: continue
            if (item.ytId == skipId || !seen.add(item.ytId!!)) continue
            out.add(item)
        }
        return Page(out, continuationOf(panel))
    }

    private fun itemOf(r: JSONObject): YtMusic.Item? {
        val id = r.optStr("videoId")
            ?: r.optJSONObject("navigationEndpoint")?.optJSONObject("watchEndpoint")?.optStr("videoId")
            ?: return null
        if (!SessionPolicy.isValidYtId(id)) return null
        val title = ArtistPage.textOf(r.optJSONObject("title"))?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val runs = r.optJSONObject("longBylineText")?.optJSONArray("runs")
            ?: r.optJSONObject("shortBylineText")?.optJSONArray("runs")
        val (artist, channelId) = artistOf(runs)
        return YtMusic.Item(
            kind = "song",
            title = title,
            subtitle = artist,
            url = "https://music.youtube.com/watch?v=$id",
            ytId = id,
            durationSec = ArtistPage.durationOf(ArtistPage.textOf(r.optJSONObject("lengthText"))),
            thumbnailUrl = thumbnailOf(r.optJSONObject("thumbnail")),
            artistUrl = channelId?.let { "https://www.youtube.com/channel/$it" },
            channelId = channelId,
        )
    }

    /**
     * The credit: the byline runs before the first " • " (songs: "Artist • Album • Year";
     * videos: "Channel • 2.1B views • 14M likes"), and the first UC… channel among them.
     */
    private fun artistOf(runs: JSONArray?): Pair<String, String?> {
        if (runs == null) return "" to null
        val sb = StringBuilder()
        var channel: String? = null
        for (i in 0 until runs.length()) {
            val run = runs.optJSONObject(i) ?: continue
            val text = run.optString("text", "")
            if (text.trim() == "•") break
            sb.append(text)
            if (channel == null) {
                channel = run.optJSONObject("navigationEndpoint")?.optJSONObject("browseEndpoint")
                    ?.optStr("browseId")?.takeIf { it.startsWith("UC") }
            }
        }
        return sb.toString().trim() to channel
    }

    private fun continuationOf(panel: JSONObject): String? {
        val arr = panel.optJSONArray("continuations") ?: return null
        for (i in 0 until arr.length()) {
            val c = arr.optJSONObject(i) ?: continue
            val data = c.optJSONObject("nextRadioContinuationData") ?: c.optJSONObject("nextContinuationData")
            data?.optStr("continuation")?.let { return it }
        }
        return null
    }

    /** The smallest thumbnail at least 240px high (else the largest), https only. */
    private fun thumbnailOf(holder: JSONObject?): String? {
        val arr = holder?.optJSONArray("thumbnails") ?: return null
        var best: Pair<String, Int>? = null
        var largest: Pair<String, Int>? = null
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val raw = o.optStr("url") ?: continue
            val url = if (raw.startsWith("//")) "https:$raw" else raw
            if (!url.startsWith("https://")) continue
            val h = o.optInt("height", 0)
            if (h >= 240 && (best == null || h < best.second)) best = url to h
            if (largest == null || h > largest.second) largest = url to h
        }
        return (best ?: largest)?.first
    }

    private val TOPIC = Regex("""\s+-\s+Topic$""", RegexOption.IGNORE_CASE)

    /** A credit without YouTube's " - Topic" channel suffix (like cleanCredit on the web side). */
    fun cleanCredit(credit: String): String = credit.replace(TOPIC, "").trim()

    private fun JSONObject.optStr(key: String): String? =
        if (!has(key) || isNull(key)) null else (opt(key) as? String)?.takeIf { it.isNotEmpty() }
}
