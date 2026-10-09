package io.github.iamandelib.cyberjuke.yt

import org.json.JSONArray
import org.json.JSONObject

/**
 * Pure parsing of YouTube Music artist pages (InnerTube `browse` JSON, WEB_REMIX client) and
 * release classification. No network and no Android types besides org.json, so it is
 * unit-tested on the JVM (ArtistPageTest, fixture `artist_page.json`).
 *
 * The response layout shifts over time, so renderers are searched for anywhere in the tree
 * rather than followed along hardcoded paths.
 */
internal object ArtistPage {

    enum class Kind(val js: String) { ALBUM("album"), EP("ep"), SINGLE("single"), LIVE("live") }

    data class Release(
        val kind: Kind,
        val title: String,
        val year: String?,
        /** `https://music.youtube.com/playlist?list=OLAK5uy_…`, or a `/browse/MPREb_…` URL
         *  that [YtMusic.playlist] resolves lazily. */
        val url: String,
        val thumbnailUrl: String?,
    )

    data class Song(
        val ytId: String,
        val title: String,
        val subtitle: String,
        val durationSec: Long?,
        val thumbnailUrl: String?,
        val channelId: String?,
    )

    /** A shelf's "See all" target: browse [browseId] with [params]; [shelf] is its title. */
    data class More(val browseId: String, val params: String?, val shelf: String?)

    data class Parsed(
        val name: String,
        val thumbnailUrl: String?,
        val topSongs: List<Song>,
        val topSongsPlaylistUrl: String?,
        val releases: List<Release>,
        val moreAlbums: More?,
        val moreSingles: More?,
    ) {
        val isEmpty: Boolean get() = topSongs.isEmpty() && releases.isEmpty()
    }

    // ---- classification ---------------------------------------------------------------------

    private val LIVE_TITLE = Regex("""\blive\b|unplugged|in concert|live at|live from""", RegexOption.IGNORE_CASE)
    private val LIVE_WORD = Regex("""\blive\b""", RegexOption.IGNORE_CASE)
    private val YEAR = Regex("""(?<![0-9])(1[89][0-9]{2}|20[0-9]{2})(?![0-9])""")
    private val EP_WORD = Regex("""\beps?\b""", RegexOption.IGNORE_CASE)
    private val SEP = Regex("""\s*[•·]\s*""")

    /**
     * Release kind from the item's subtitle ("Album • 2019", "EP", "Single • 2021"), with the
     * shelf title ("Albums", "Singles & EPs", …) as the backup. Albums and EPs are [Kind.LIVE]
     * when the subtitle says Live or the title looks like a live recording.
     */
    fun classify(subtitle: String?, title: String, shelfTitle: String?): Kind {
        val first = subtitle?.split(SEP)?.firstOrNull()?.trim()?.lowercase() ?: ""
        val base = when {
            first == "album" -> Kind.ALBUM
            first == "ep" -> Kind.EP
            first == "single" -> Kind.SINGLE
            first.startsWith("live") -> Kind.LIVE
            else -> kindOfShelf(shelfTitle) ?: Kind.ALBUM
        }
        if (base == Kind.SINGLE || base == Kind.LIVE) return base
        if ((subtitle != null && LIVE_WORD.containsMatchIn(subtitle)) || LIVE_TITLE.containsMatchIn(title)) {
            return Kind.LIVE
        }
        return base
    }

    /** "Albums" -> ALBUM, "Singles & EPs" / "Singles" -> SINGLE, "EPs" -> EP, "Live" -> LIVE. */
    fun kindOfShelf(shelfTitle: String?): Kind? {
        val s = shelfTitle?.lowercase() ?: return null
        return when {
            LIVE_WORD.containsMatchIn(s) -> Kind.LIVE
            s.contains("single") -> Kind.SINGLE
            EP_WORD.containsMatchIn(s) -> Kind.EP
            s.contains("album") -> Kind.ALBUM
            else -> null
        }
    }

    /**
     * Fallback classification when only a title (and maybe a track count) is known, e.g. the
     * YouTube channel's Releases tab: live by title, " - EP" / " - Single" suffixes, else
     * 1–3 tracks a single, 4–6 an EP, otherwise an album.
     */
    fun classifyByTitle(title: String, trackCount: Long?): Kind {
        val t = title.lowercase()
        val byTitle = when {
            Regex("""[-–(\[]\s*single\b""").containsMatchIn(t) -> Kind.SINGLE
            Regex("""[-–(\[]\s*ep\b|\bep$""").containsMatchIn(t) -> Kind.EP
            else -> null
        }
        val base = byTitle ?: when {
            trackCount == null || trackCount <= 0 -> Kind.ALBUM
            trackCount <= 3 -> Kind.SINGLE
            trackCount <= 6 -> Kind.EP
            else -> Kind.ALBUM
        }
        if (base != Kind.SINGLE && LIVE_TITLE.containsMatchIn(title)) return Kind.LIVE
        return base
    }

    /** The release year in a subtitle ("Album • 2019" -> 2019); the last one if several. */
    fun yearOf(subtitle: String?): String? =
        subtitle?.let { s -> YEAR.findAll(s).lastOrNull()?.value }

    // ---- page parsing -----------------------------------------------------------------------

    private val HEADER_KEYS = listOf(
        "musicImmersiveHeaderRenderer",
        "musicVisualHeaderRenderer",
        "musicResponsiveHeaderRenderer",
    )
    private val RELEASE_SHELF = Regex("""album|single|\beps?\b|\blive\b|release|discography""", RegexOption.IGNORE_CASE)
    private val NOT_RELEASE_SHELF = Regex("""appears on|featured|playlist|video""", RegexOption.IGNORE_CASE)

    /** Parse an artist page (`browse` with browseId = the artist's channel id). */
    fun parseArtist(root: JSONObject, channelId: String?): Parsed {
        val header = HEADER_KEYS.firstNotNullOfOrNull { findFirst(root, it) }
        val name = textOf(header?.optJSONObject("title"))
            ?: findFirst(root, "microformatDataRenderer")?.optStr("title")
            ?: ""
        val headerThumb = header?.let {
            thumbnailOf(it.optJSONObject("foregroundThumbnail"), large = true)
                ?: thumbnailOf(it.optJSONObject("thumbnail"), large = true)
        }

        // Top songs: the first list shelf that holds song rows.
        var songs = emptyList<Song>()
        var songsUrl: String? = null
        for (shelf in findAll(root, "musicShelfRenderer")) {
            val rows = findAll(shelf.optJSONArray("contents"), "musicResponsiveListItemRenderer")
            val parsed = rows.mapNotNull { songOf(it, channelId) }
            if (parsed.isEmpty()) continue
            songs = parsed.distinctBy { it.ytId }
            val browse = shelf.optJSONObject("bottomEndpoint")?.optJSONObject("browseEndpoint")
                ?: findFirst(shelf.optJSONObject("title"), "browseEndpoint")
                ?: findFirst(shelf.optJSONObject("bottomButton"), "browseEndpoint")
            songsUrl = browse?.optStr("browseId")?.takeIf { it.startsWith("VL") && it.length > 2 }
                ?.let { playlistUrl(it.removePrefix("VL")) }
            break
        }

        val releases = ArrayList<Release>()
        var moreAlbums: More? = null
        var moreSingles: More? = null
        for (shelf in findAll(root, "musicCarouselShelfRenderer")) {
            val head = findFirst(shelf.optJSONObject("header"), "musicCarouselShelfBasicHeaderRenderer")
                ?: shelf.optJSONObject("header")
            val shelfTitle = textOf(head?.optJSONObject("title")) ?: continue
            if (!RELEASE_SHELF.containsMatchIn(shelfTitle) || NOT_RELEASE_SHELF.containsMatchIn(shelfTitle)) continue
            val items = findAll(shelf.optJSONArray("contents"), "musicTwoRowItemRenderer")
                .mapNotNull { releaseOf(it, shelfTitle) }
            if (items.isEmpty()) continue
            releases.addAll(items)
            val more = head?.let { moreOf(it, shelfTitle) } ?: continue
            when (kindOfShelf(shelfTitle)) {
                Kind.SINGLE, Kind.EP -> if (moreSingles == null) moreSingles = more
                Kind.ALBUM -> if (moreAlbums == null) moreAlbums = more
                else -> {}
            }
        }

        return Parsed(
            name = name,
            thumbnailUrl = headerThumb,
            topSongs = songs,
            topSongsPlaylistUrl = songsUrl,
            releases = releases.distinctBy { it.url },
            moreAlbums = moreAlbums,
            moreSingles = moreSingles,
        )
    }

    /** Parse a "See all" discography grid (`browse` with a [More] token). */
    fun parseReleases(root: JSONObject, shelfTitle: String?): List<Release> {
        val grid = findFirst(root, "gridRenderer")
        val title = shelfTitle ?: textOf(findFirst(grid?.optJSONObject("header"), "title"))
        return findAll(grid ?: root, "musicTwoRowItemRenderer")
            .mapNotNull { releaseOf(it, title) }
            .distinctBy { it.url }
    }

    /**
     * The album's audio playlist id (OLAK5uy_…) from an album `browse` (MPREb_…) response:
     * `microformat…urlCanonical`, else a play button's playlist id.
     */
    fun albumPlaylistIdOf(root: JSONObject): String? {
        findFirst(root, "microformatDataRenderer")?.optStr("urlCanonical")
            ?.let { listParam(it) }?.let { return it }
        return playlistIdIn(root)
    }

    /** `https://music.youtube.com/playlist?list=<id>`. */
    fun playlistUrl(listId: String) = "https://music.youtube.com/playlist?list=$listId"

    /** URL for an album whose playlist id is not known yet; [YtMusic.playlist] resolves it. */
    fun albumBrowseUrl(browseId: String) = "https://music.youtube.com/browse/$browseId"

    private val MPREB = Regex("""MPREb_[A-Za-z0-9_-]+""")

    /** The MPREb_… album browse id in a URL, if any. */
    fun albumBrowseIdOf(url: String): String? = MPREB.find(url)?.value

    // ---- items ------------------------------------------------------------------------------

    private fun releaseOf(item: JSONObject, shelfTitle: String?): Release? {
        val titleObj = item.optJSONObject("title")
        val title = textOf(titleObj)?.takeIf { it.isNotBlank() } ?: return null
        val browseId = item.optJSONObject("navigationEndpoint")?.optJSONObject("browseEndpoint")?.optStr("browseId")
            ?: findFirst(titleObj, "browseEndpoint")?.optStr("browseId")
            ?: return null
        val playlistId = playlistIdIn(item)
        val url = when {
            browseId.startsWith("MPREb_") -> playlistId?.let(::playlistUrl) ?: albumBrowseUrl(browseId)
            browseId.startsWith("VL") && browseId.length > 2 -> playlistUrl(browseId.removePrefix("VL"))
            else -> return null // artists, videos, user playlists
        }
        val subtitle = textOf(item.optJSONObject("subtitle"))
        return Release(
            kind = classify(subtitle, title, shelfTitle),
            title = title,
            year = yearOf(subtitle),
            url = url,
            thumbnailUrl = thumbnailOf(item.optJSONObject("thumbnailRenderer"), large = false),
        )
    }

    private fun songOf(row: JSONObject, pageChannelId: String?): Song? {
        val videoId = row.optJSONObject("playlistItemData")?.optStr("videoId")
            ?: findFirst(row, "watchEndpoint")?.optStr("videoId")
            ?: return null
        val cols = row.optJSONArray("flexColumns")
        fun col(i: Int): JSONObject? =
            cols?.optJSONObject(i)?.let { it.optJSONObject("musicResponsiveListItemFlexColumnRenderer") ?: it }
                ?.optJSONObject("text")
        val title = textOf(col(0))?.takeIf { it.isNotBlank() } ?: return null
        val artistsText = col(1)
        val subtitle = (textOf(artistsText) ?: "").replace(Regex("""^(Song|Video)\s*•\s*"""), "").trim()
        var channel: String? = null
        val runs = artistsText?.optJSONArray("runs")
        if (runs != null) {
            for (i in 0 until runs.length()) {
                val id = runs.optJSONObject(i)?.optJSONObject("navigationEndpoint")
                    ?.optJSONObject("browseEndpoint")?.optStr("browseId")
                if (id != null && id.startsWith("UC")) { channel = id; break }
            }
        }
        val fixed = row.optJSONArray("fixedColumns")?.optJSONObject(0)
            ?.let { it.optJSONObject("musicResponsiveListItemFixedColumnRenderer") ?: it }
        return Song(
            ytId = videoId,
            title = title,
            subtitle = subtitle,
            durationSec = durationOf(textOf(fixed?.optJSONObject("text"))),
            thumbnailUrl = thumbnailOf(row.optJSONObject("thumbnail"), large = false),
            channelId = channel ?: pageChannelId,
        )
    }

    private fun moreOf(head: JSONObject, shelfTitle: String): More? {
        val browse = findFirst(head.optJSONObject("moreContentButton"), "browseEndpoint")
            ?: findFirst(head.optJSONObject("title"), "browseEndpoint")
            ?: return null
        val id = browse.optStr("browseId") ?: return null
        return More(id, browse.optStr("params"), shelfTitle)
    }

    /** "3:45" / "1:02:03" -> seconds. */
    fun durationOf(s: String?): Long? {
        val parts = s?.trim()?.split(":") ?: return null
        if (parts.size !in 2..3) return null
        var total = 0L
        for (p in parts) total = total * 60 + (p.toLongOrNull() ?: return null)
        return total.takeIf { it > 0 }
    }

    /**
     * An album's playlist id inside an item: a watchPlaylistEndpoint / watchEndpoint playlist
     * id, preferring OLAK5uy_… and never a radio (RD…).
     */
    private fun playlistIdIn(root: Any?): String? {
        val ids = ArrayList<String>()
        for (key in listOf("watchPlaylistEndpoint", "watchEndpoint")) {
            for (e in findAll(root, key)) e.optStr("playlistId")?.let { ids.add(it) }
        }
        return ids.firstOrNull { it.startsWith("OLAK5uy_") }
            ?: ids.firstOrNull { !it.startsWith("RD") && it.length >= 10 }
    }

    private fun listParam(url: String): String? =
        Regex("""[?&]list=([A-Za-z0-9_-]{10,})""").find(url)?.groupValues?.get(1)

    /**
     * A thumbnail URL from anything holding a `thumbnails` array. Small: the smallest height
     * >= 240 nearest 300 (album covers, song rows); large: the smallest height >= 540
     * (artist headers). Otherwise the largest. https only.
     */
    private fun thumbnailOf(holder: JSONObject?, large: Boolean): String? {
        val list = thumbnailsOf(holder?.optJSONArray("thumbnails") ?: findFirstArray(holder, "thumbnails"))
        val min = if (large) 540 else 240
        val pick = list.filter { it.height >= min }.minByOrNull { if (large) it.height else kotlin.math.abs(it.height - 300) }
            ?: list.maxByOrNull { it.height }
        return pick?.url
    }
}
