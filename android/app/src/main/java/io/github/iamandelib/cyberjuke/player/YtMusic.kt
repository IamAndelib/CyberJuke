package io.github.iamandelib.cyberjuke.player

import org.schabi.newpipe.extractor.Image
import org.schabi.newpipe.extractor.InfoItem
import org.schabi.newpipe.extractor.ListExtractor.InfoItemsPage
import org.schabi.newpipe.extractor.Page
import org.schabi.newpipe.extractor.ServiceList
import org.json.JSONObject
import org.schabi.newpipe.extractor.channel.ChannelInfoItem
import org.schabi.newpipe.extractor.channel.tabs.ChannelTabs
import org.schabi.newpipe.extractor.exceptions.ContentNotAvailableException
import org.schabi.newpipe.extractor.playlist.PlaylistInfo
import org.schabi.newpipe.extractor.playlist.PlaylistInfoItem
import org.schabi.newpipe.extractor.search.SearchExtractor
import org.schabi.newpipe.extractor.services.youtube.linkHandler.YoutubeSearchQueryHandlerFactory
import org.schabi.newpipe.extractor.stream.StreamInfoItem
import kotlin.math.abs

/**
 * YouTube Music data (search, albums, playlists). Like [YtCompat], this is the ONLY file of
 * the music feature that touches the NewPipeExtractor API (checked against commit 13a655fe);
 * everything it returns is plain data. All calls are blocking network calls: never call them
 * on the main thread.
 */
internal object YtMusic {

    enum class Filter(val contentFilter: String) {
        SONGS(YoutubeSearchQueryHandlerFactory.MUSIC_SONGS),
        ALBUMS(YoutubeSearchQueryHandlerFactory.MUSIC_ALBUMS),
        ARTISTS(YoutubeSearchQueryHandlerFactory.MUSIC_ARTISTS),
        PLAYLISTS(YoutubeSearchQueryHandlerFactory.MUSIC_PLAYLISTS);

        companion object {
            /** 'songs' | 'albums' | 'artists' | 'playlists' (the TS contract), else null. */
            fun parse(s: String?): Filter? = when (s) {
                "songs" -> SONGS
                "albums" -> ALBUMS
                "artists" -> ARTISTS
                "playlists" -> PLAYLISTS
                else -> null
            }
        }
    }

    /** One result row; field names mirror the TS `MusicItem`. */
    data class Item(
        val kind: String, // song | album | artist | playlist
        val title: String,
        val subtitle: String,
        val url: String,
        val ytId: String? = null,
        val durationSec: Long? = null,
        val thumbnailUrl: String? = null,
        val itemCount: Long? = null,
        /** Songs/albums: the first credited artist's channel URL (NewPipe getUploaderUrl()). */
        val artistUrl: String? = null,
        /** Songs/albums: [artistUrl]'s channel id; artists: their own channel id. */
        val channelId: String? = null,
    )

    /**
     * Opaque continuation: the NewPipe [Page] plus what produced it. Callers only store it
     * and hand it back to [more].
     */
    class Continuation internal constructor(
        internal val page: Page,
        internal val searchExtractor: SearchExtractor?,
        internal val filter: Filter?,
        internal val playlistUrl: String?,
    )

    data class Result(val items: List<Item>, val next: Continuation?)

    data class Playlist(
        val title: String,
        val subtitle: String,
        val thumbnailUrl: String?,
        val items: List<Item>,
        val next: Continuation?,
    )

    fun search(query: String, filter: Filter): Result {
        YtCompat.ensureInit()
        val extractor = ServiceList.YouTube.getSearchExtractor(query, listOf(filter.contentFilter), "")
        extractor.fetchPage()
        return searchResult(extractor.initialPage, extractor, filter)
    }

    fun more(next: Continuation): Result {
        YtCompat.ensureInit()
        val ex = next.searchExtractor
        if (ex != null) {
            return searchResult(ex.getPage(next.page), ex, next.filter ?: Filter.SONGS)
        }
        val url = next.playlistUrl ?: throw IllegalStateException("bad continuation")
        val page = PlaylistInfo.getMoreItems(ServiceList.YouTube, url, next.page)
        return Result(
            page.items.mapNotNull { mapItem(it, null) },
            continuation(page.nextPage) { Continuation(it, null, null, url) },
        )
    }

    /**
     * Artist candidates for a name: the first page of a MUSIC_ARTISTS search, in YouTube's
     * ranking, keeping only results whose channel id is known.
     */
    fun artist(name: String): List<Item> =
        search(name, Filter.ARTISTS).items.filter { it.kind == "artist" && it.channelId != null }

    /**
     * Album or playlist page (YouTube Music albums are playlists too). An album browse URL
     * (`…/browse/MPREb_…`, from [artistPage]) is first resolved to its OLAK5uy_ playlist.
     */
    fun playlist(url: String): Playlist {
        YtCompat.ensureInit()
        val target = ArtistPage.albumBrowseIdOf(url)
            ?.let { ArtistPage.playlistUrl(albumPlaylistId(it)) }
            ?: url
        val info = PlaylistInfo.getInfo(ServiceList.YouTube, target)
        val pageUrl = info.url ?: target
        return Playlist(
            title = info.name ?: "",
            subtitle = info.uploaderName ?: "",
            thumbnailUrl = bestThumbnail(info.thumbnails),
            items = info.relatedItems.mapNotNull { mapItem(it, null) },
            next = continuation(info.nextPage) { Continuation(it, null, null, pageUrl) },
        )
    }

    // ---- radio (InnerTube next, see Radio) -----------------------------------------------

    /**
     * YouTube Music's radio for [videoId] (`RDAMVM<videoId>`): about 25-50 songs a page, without
     * the seed itself, and the continuation for the next page (null at the end). With
     * [continuation], the page after it. Refused (BlockedException) during a back-off (Y1).
     */
    fun radio(videoId: String, continuation: String? = null): Radio.Page {
        NetBlock.check()
        YtCompat.ensureInit()
        val json = InnerTube.post("next", Radio.payload(videoId, continuation))
            ?: throw ContentNotAvailableException("radio $videoId not found")
        return Radio.parse(json, videoId)
    }

    // ---- artist pages (InnerTube browse, see ArtistPage) ---------------------------------

    data class Artist(
        val name: String,
        val thumbnailUrl: String?,
        val topSongs: List<Item>,
        val topSongsPlaylistUrl: String?,
        val releases: List<ArtistPage.Release>,
        val moreAlbums: ArtistPage.More?,
        val moreSingles: ArtistPage.More?,
        /** "innertube", "innertube+releases-tab" or "releases-tab" (for logs only). */
        val source: String,
    )

    /**
     * The YouTube Music artist page for a channel id: header, top songs, release shelves and
     * their "See all" tokens. When it yields no releases, the YouTube channel's Releases tab
     * (NewPipe, ChannelTabs.ALBUMS) supplies them, classified by title. Throws the artist
     * page's error only when neither source produced anything.
     */
    fun artistPage(channelId: String): Artist {
        YtCompat.ensureInit()
        var parsed: ArtistPage.Parsed? = null
        var failure: Throwable? = null
        try {
            val json = InnerTube.post("browse", JSONObject().put("browseId", channelId))
                ?: throw ContentNotAvailableException("artist page $channelId not found")
            parsed = ArtistPage.parseArtist(json, channelId)
        } catch (t: Throwable) {
            failure = t
        }
        val p = parsed
        if (p != null && p.releases.isNotEmpty()) return artistOf(p, p.releases, "innertube")

        val tab = try {
            releasesTab(channelId)
        } catch (t: Throwable) {
            if (p == null) throw failure ?: t
            null
        }
        if (p == null && tab?.second.isNullOrEmpty()) {
            throw failure ?: ContentNotAvailableException("artist $channelId has no releases")
        }
        val releases = tab?.second ?: emptyList()
        if (p != null) return artistOf(p, releases, if (releases.isEmpty()) "innertube" else "innertube+releases-tab")
        return Artist(
            name = tab?.first ?: "",
            thumbnailUrl = null,
            topSongs = emptyList(),
            topSongsPlaylistUrl = null,
            releases = releases,
            moreAlbums = null,
            moreSingles = null,
            source = "releases-tab",
        )
    }

    /** A "See all" discography grid for a token from [artistPage]. */
    fun artistReleases(more: ArtistPage.More): List<ArtistPage.Release> {
        YtCompat.ensureInit()
        val payload = JSONObject().put("browseId", more.browseId)
        more.params?.let { payload.put("params", it) }
        val json = InnerTube.post("browse", payload)
            ?: throw ContentNotAvailableException("releases ${more.browseId} not found")
        return ArtistPage.parseReleases(json, more.shelf)
    }

    private fun artistOf(p: ArtistPage.Parsed, releases: List<ArtistPage.Release>, source: String) = Artist(
        name = p.name,
        thumbnailUrl = p.thumbnailUrl,
        topSongs = p.topSongs.map { s ->
            Item(
                kind = "song",
                title = s.title,
                subtitle = s.subtitle,
                url = "https://music.youtube.com/watch?v=${s.ytId}",
                ytId = s.ytId,
                durationSec = s.durationSec,
                thumbnailUrl = s.thumbnailUrl,
                artistUrl = s.channelId?.let { "https://www.youtube.com/channel/$it" },
                channelId = s.channelId,
            )
        },
        topSongsPlaylistUrl = p.topSongsPlaylistUrl,
        releases = releases,
        moreAlbums = p.moreAlbums,
        moreSingles = p.moreSingles,
        source = source,
    )

    /** (channel name or null, releases) from the YouTube channel's Releases tab. */
    private fun releasesTab(channelId: String): Pair<String?, List<ArtistPage.Release>> {
        val ex = ServiceList.YouTube.getChannelTabExtractorFromId("channel/$channelId", ChannelTabs.ALBUMS)
        ex.fetchPage()
        val items = ex.initialPage.items.filterIsInstance<PlaylistInfoItem>()
        val releases = items.mapNotNull { it ->
            val url = it.url ?: return@mapNotNull null
            val title = it.name ?: return@mapNotNull null
            ArtistPage.Release(
                kind = ArtistPage.classifyByTitle(title, it.streamCount.takeIf { n -> n > 0 }),
                title = title,
                year = null,
                url = url,
                thumbnailUrl = bestThumbnail(it.thumbnails),
            )
        }.distinctBy { it.url }
        return items.firstNotNullOfOrNull { it.uploaderName?.takeIf { n -> n.isNotBlank() } } to releases
    }

    private val albumIds = object : LinkedHashMap<String, String>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > 200
    }

    /** MPREb_… album browse id -> its OLAK5uy_… playlist id (one `browse`, cached). */
    private fun albumPlaylistId(browseId: String): String {
        synchronized(albumIds) { albumIds[browseId] }?.let { return it }
        val json = InnerTube.post("browse", JSONObject().put("browseId", browseId))
            ?: throw ContentNotAvailableException("album $browseId not found")
        val id = ArtistPage.albumPlaylistIdOf(json)
            ?: throw ContentNotAvailableException("album $browseId has no playlist")
        synchronized(albumIds) { albumIds[browseId] = id }
        return id
    }

    /**
     * BOT_CHECK | NETWORK | UNAVAILABLE, for the plugin's reject code: bot checks and rate
     * limits (HTTP 429) are BOT_CHECK; I/O failures and HTTP 5xx anywhere in the cause chain
     * are NETWORK; everything else (missing content, parse errors) is UNAVAILABLE.
     */
    fun errorCode(t: Throwable): String = when (YtCompat.classify(t)) {
        FailureKind.BOT_CHECK, FailureKind.RATE_LIMIT -> "BOT_CHECK"
        FailureKind.NETWORK -> "NETWORK"
        else -> "UNAVAILABLE"
    }

    fun describe(t: Throwable): String = YtCompat.describe(t)

    // ---- mapping ------------------------------------------------------------------------

    private fun searchResult(page: InfoItemsPage<InfoItem>, ex: SearchExtractor, filter: Filter) =
        Result(
            page.items.mapNotNull { mapItem(it, filter) },
            continuation(page.nextPage) { Continuation(it, ex, filter, null) },
        )

    private inline fun continuation(page: Page?, make: (Page) -> Continuation): Continuation? =
        if (Page.isValid(page)) make(page!!) else null

    private fun mapItem(item: InfoItem, filter: Filter?): Item? {
        val url = item.url ?: return null
        val title = item.name ?: ""
        val thumb = bestThumbnail(item.thumbnails)
        return when (item) {
            is StreamInfoItem -> {
                val id = ytIdOf(url) ?: return null
                Item(
                    kind = "song",
                    title = title,
                    subtitle = item.uploaderName ?: "",
                    url = url,
                    ytId = id,
                    durationSec = item.duration.takeIf { it > 0 },
                    thumbnailUrl = thumb,
                    artistUrl = item.uploaderUrl,
                    channelId = MusicText.channelIdOf(item.uploaderUrl),
                )
            }
            is PlaylistInfoItem -> Item(
                kind = if (filter == Filter.ALBUMS) "album" else "playlist",
                title = title,
                subtitle = item.uploaderName ?: "",
                url = url,
                thumbnailUrl = thumb,
                itemCount = item.streamCount.takeIf { it >= 0 },
                artistUrl = item.uploaderUrl,
                channelId = MusicText.channelIdOf(item.uploaderUrl),
            )
            is ChannelInfoItem -> Item(
                kind = "artist",
                title = title,
                subtitle = item.description?.takeIf { it.isNotBlank() } ?: "",
                url = url,
                thumbnailUrl = thumb,
                channelId = MusicText.channelIdOf(url),
            )
            else -> null
        }
    }

    private val ID_RE = Regex("""(?:[?&]v=|youtu\.be/|/shorts/|/embed/)([A-Za-z0-9_-]{11})""")

    private fun ytIdOf(url: String): String? =
        runCatching { ServiceList.YouTube.streamLHFactory.getId(url) }.getOrNull()
            ?.takeIf { it.isNotBlank() }
            ?: ID_RE.find(url)?.groupValues?.get(1)

    /**
     * Thumbnail closest to ~300px: the smallest known height >= 240, else the largest known,
     * else (no sizes known) the first one.
     */
    private fun bestThumbnail(images: List<Image>?): String? {
        if (images.isNullOrEmpty()) return null
        val known = images.filter { it.height > 0 }
        val pick = known.filter { it.height >= 240 }.minByOrNull { abs(it.height - 300) }
            ?: known.maxByOrNull { it.height }
            ?: images.first()
        return pick.url
    }
}
