package io.github.iamandelib.cyberjuke.player

import org.schabi.newpipe.extractor.Image
import org.schabi.newpipe.extractor.InfoItem
import org.schabi.newpipe.extractor.ListExtractor.InfoItemsPage
import org.schabi.newpipe.extractor.Page
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.channel.ChannelInfoItem
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import org.schabi.newpipe.extractor.exceptions.SignInConfirmNotBotException
import org.schabi.newpipe.extractor.playlist.PlaylistInfo
import org.schabi.newpipe.extractor.playlist.PlaylistInfoItem
import org.schabi.newpipe.extractor.search.SearchExtractor
import org.schabi.newpipe.extractor.services.youtube.linkHandler.YoutubeSearchQueryHandlerFactory
import org.schabi.newpipe.extractor.stream.StreamInfoItem
import java.io.IOException
import kotlin.math.abs

/**
 * YouTube Music data (search, albums, playlists). Like [YtCompat], this is the ONLY file of
 * the music feature that touches the NewPipeExtractor API (checked against tag v0.26.5);
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

    /** Album or playlist page (YouTube Music albums are playlists too). */
    fun playlist(url: String): Playlist {
        YtCompat.ensureInit()
        val info = PlaylistInfo.getInfo(ServiceList.YouTube, url)
        val pageUrl = info.url ?: url
        return Playlist(
            title = info.name ?: "",
            subtitle = info.uploaderName ?: "",
            thumbnailUrl = bestThumbnail(info.thumbnails),
            items = info.relatedItems.mapNotNull { mapItem(it, null) },
            next = continuation(info.nextPage) { Continuation(it, null, null, pageUrl) },
        )
    }

    /** BOT_CHECK | NETWORK | UNAVAILABLE, for the plugin's reject code. */
    fun errorCode(t: Throwable): String = when (t) {
        is SignInConfirmNotBotException, is ReCaptchaException -> "BOT_CHECK"
        is IOException -> "NETWORK"
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
                )
            }
            is PlaylistInfoItem -> Item(
                kind = if (filter == Filter.ALBUMS) "album" else "playlist",
                title = title,
                subtitle = item.uploaderName ?: "",
                url = url,
                thumbnailUrl = thumb,
                itemCount = item.streamCount.takeIf { it >= 0 },
            )
            is ChannelInfoItem -> Item(
                kind = "artist",
                title = title,
                subtitle = item.description?.takeIf { it.isNotBlank() } ?: "",
                url = url,
                thumbnailUrl = thumb,
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
