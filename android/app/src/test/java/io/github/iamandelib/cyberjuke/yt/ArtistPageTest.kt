package io.github.iamandelib.cyberjuke.yt

import io.github.iamandelib.cyberjuke.yt.ArtistPage.Kind
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ArtistPageTest {

    private fun fixture(name: String): JSONObject {
        val stream = javaClass.classLoader!!.getResourceAsStream(name) ?: error("missing fixture $name")
        return JSONObject(stream.bufferedReader().use { it.readText() })
    }

    // ---- classification -----------------------------------------------------------------

    @Test
    fun kindFromSubtitleFirstToken() {
        assertEquals(Kind.ALBUM, ArtistPage.classify("Album • 2019", "Jazz", "Albums"))
        assertEquals(Kind.EP, ArtistPage.classify("EP • 2020", "Something", "Albums"))
        assertEquals(Kind.SINGLE, ArtistPage.classify("Single • 2021", "Something", "Albums"))
        assertEquals(Kind.EP, ArtistPage.classify("EP", "Something", null))
        assertEquals(Kind.LIVE, ArtistPage.classify("Live • 1992", "Live at Wembley '86", "Albums"))
    }

    @Test
    fun shelfTitleIsTheBackup() {
        assertEquals(Kind.ALBUM, ArtistPage.classify("1991", "Innuendo", "Albums"))
        assertEquals(Kind.SINGLE, ArtistPage.classify("2000", "B-sides", "Singles & EPs"))
        assertEquals(Kind.SINGLE, ArtistPage.classify(null, "B-sides", "Singles"))
        assertEquals(Kind.EP, ArtistPage.classify("2000", "B-sides", "EPs"))
        assertEquals(Kind.LIVE, ArtistPage.classify("1979", "Killers", "Live albums"))
        assertEquals(Kind.ALBUM, ArtistPage.classify(null, "Whatever", null))
        assertEquals(Kind.ALBUM, ArtistPage.classify("", "Whatever", "Discography"))
    }

    @Test
    fun liveAlbumsAndEpsByTitleOrSubtitle() {
        assertEquals(Kind.LIVE, ArtistPage.classify("Album • 1979", "Live Killers", "Albums"))
        assertEquals(Kind.LIVE, ArtistPage.classify("Album • 1994", "MTV Unplugged in New York", "Albums"))
        assertEquals(Kind.LIVE, ArtistPage.classify("Album • 1969", "At San Quentin (In Concert)", "Albums"))
        assertEquals(Kind.LIVE, ArtistPage.classify("Album • 2007", "LIVE FROM THE O2", "Albums"))
        assertEquals(Kind.LIVE, ArtistPage.classify("EP • 1985", "Live Aid EP", "Singles & EPs"))
        assertEquals(Kind.LIVE, ArtistPage.classify("Album • Live • 2001", "Hits", "Albums"))
        // Word boundaries: these are studio albums.
        assertEquals(Kind.ALBUM, ArtistPage.classify("Album • 1995", "Alive", "Albums"))
        assertEquals(Kind.ALBUM, ArtistPage.classify("Album • 2002", "Deliverance", "Albums"))
        assertEquals(Kind.ALBUM, ArtistPage.classify("Album • 2010", "Olive Tree", "Albums"))
        assertEquals(Kind.ALBUM, ArtistPage.classify("Album • 1999", "Livewire", "Albums"))
        // Singles stay singles, even live ones.
        assertEquals(Kind.SINGLE, ArtistPage.classify("Single • 1994", "Live Forever", "Singles"))
        assertEquals(Kind.SINGLE, ArtistPage.classify("Single • 1985", "Love of My Life (Live at Rock in Rio)", null))
    }

    @Test
    fun yearFromSubtitle() {
        assertEquals("2019", ArtistPage.yearOf("Album • 2019"))
        assertEquals("1975", ArtistPage.yearOf("1975"))
        assertEquals("2021", ArtistPage.yearOf("Single • Queen • 2021"))
        assertNull(ArtistPage.yearOf("EP"))
        assertNull(ArtistPage.yearOf(null))
        assertNull(ArtistPage.yearOf("Album • 12345 plays"))
        assertNull(ArtistPage.yearOf("Album • 1.2B views"))
    }

    @Test
    fun classifyByTitleFallback() {
        assertEquals(Kind.SINGLE, ArtistPage.classifyByTitle("Face It Alone - Single", null))
        assertEquals(Kind.EP, ArtistPage.classifyByTitle("Queen Rocks - EP", null))
        assertEquals(Kind.LIVE, ArtistPage.classifyByTitle("Live at the Rainbow '74", 22))
        assertEquals(Kind.ALBUM, ArtistPage.classifyByTitle("Jazz", 13))
        assertEquals(Kind.ALBUM, ArtistPage.classifyByTitle("Jazz", null))
        assertEquals(Kind.SINGLE, ArtistPage.classifyByTitle("Face It Alone", 1))
        assertEquals(Kind.EP, ArtistPage.classifyByTitle("Five", 5))
        assertEquals(Kind.LIVE, ArtistPage.classifyByTitle("Five Live", 5))
        assertEquals(Kind.SINGLE, ArtistPage.classifyByTitle("Live Forever", 2))
    }

    @Test
    fun durations() {
        assertEquals(355L, ArtistPage.durationOf("5:55"))
        assertEquals(3723L, ArtistPage.durationOf("1:02:03"))
        assertNull(ArtistPage.durationOf("1.2B plays"))
        assertNull(ArtistPage.durationOf(null))
    }

    // ---- parsing ----------------------------------------------------------------------------

    @Test
    fun parsesArtistPageFixture() {
        val p = ArtistPage.parseArtist(fixture("artist_page.json"), "UCEPMVbUzImPl4p8k4LkGevA")
        assertEquals("Queen", p.name)
        assertEquals("https://lh3/q=w1440", p.thumbnailUrl)

        // Top songs: deduplicated, artist credit kept, channel from the first artist run.
        assertEquals(listOf("fJ9rUzIMcZQ", "HgzGwKwLmgM", "a01QQZyl-_I"), p.topSongs.map { it.ytId })
        assertEquals("Bohemian Rhapsody", p.topSongs[0].title)
        assertEquals("Queen", p.topSongs[0].subtitle)
        assertEquals(355L, p.topSongs[0].durationSec)
        assertNull(p.topSongs[1].durationSec)
        assertEquals("Queen & David Bowie", p.topSongs[2].subtitle)
        assertEquals("UCEPMVbUzImPl4p8k4LkGevA", p.topSongs[2].channelId)
        assertTrue(p.topSongs[0].thumbnailUrl!!.endsWith("w120-h120"))
        assertEquals(
            "https://music.youtube.com/playlist?list=OLAK5uy_topsongsQueenXXXXXXXXXXXXXXXXXX",
            p.topSongsPlaylistUrl,
        )

        // Releases: only the release shelves, in page order (videos, playlists, artists skipped).
        val byTitle = p.releases.associateBy { it.title }
        assertEquals(
            listOf(
                "A Night at the Opera", "Live Killers", "Live at Wembley '86", "Innuendo",
                "Face It Alone", "Queen Rocks EP", "Live Aid EP", "Untitled B-sides",
            ),
            p.releases.map { it.title },
        )
        assertEquals(Kind.ALBUM, byTitle["A Night at the Opera"]!!.kind)
        assertEquals("1975", byTitle["A Night at the Opera"]!!.year)
        assertEquals(Kind.LIVE, byTitle["Live Killers"]!!.kind)
        assertEquals(Kind.LIVE, byTitle["Live at Wembley '86"]!!.kind)
        assertEquals(Kind.ALBUM, byTitle["Innuendo"]!!.kind)
        assertEquals("1991", byTitle["Innuendo"]!!.year)
        assertEquals(Kind.SINGLE, byTitle["Face It Alone"]!!.kind)
        assertEquals(Kind.EP, byTitle["Queen Rocks EP"]!!.kind)
        assertEquals(Kind.LIVE, byTitle["Live Aid EP"]!!.kind)
        assertEquals(Kind.SINGLE, byTitle["Untitled B-sides"]!!.kind)

        // URLs: the play button's OLAK5uy_ id when present (never the RDAMPL radio), else the
        // MPREb_ browse URL that playlist() resolves lazily.
        assertEquals(
            "https://music.youtube.com/playlist?list=OLAK5uy_operaXXXXXXXXXXXXXXXXXXXXXXXXXXX",
            byTitle["A Night at the Opera"]!!.url,
        )
        assertEquals("https://music.youtube.com/browse/MPREb_killers001", byTitle["Live Killers"]!!.url)
        assertEquals("MPREb_killers001", ArtistPage.albumBrowseIdOf(byTitle["Live Killers"]!!.url))
        assertNull(ArtistPage.albumBrowseIdOf(byTitle["A Night at the Opera"]!!.url))
        assertTrue(byTitle["A Night at the Opera"]!!.thumbnailUrl!!.endsWith("w544-h544"))

        // "See all" tokens per shelf.
        assertEquals(
            ArtistPage.More("MPADUCEPMVbUzImPl4p8k4LkGevA", "ggMIegYIARoCAQI%3D", "Albums"),
            p.moreAlbums,
        )
        assertEquals(
            ArtistPage.More("MPADUCEPMVbUzImPl4p8k4LkGevA", "ggMIegYIAhoCAQI%3D", "Singles & EPs"),
            p.moreSingles,
        )
    }

    @Test
    fun parsesReleasesGrid() {
        val r = ArtistPage.parseReleases(fixture("artist_releases.json"), "Singles & EPs")
        assertEquals(4, r.size)
        assertEquals(listOf(Kind.SINGLE, Kind.SINGLE, Kind.EP, Kind.SINGLE), r.map { it.kind })
        assertEquals(listOf("2022", "2018", "2011", "1985"), r.map { it.year })
        // The grid's own header is used when the token carries no shelf title.
        val untitled = ArtistPage.parseReleases(fixture("artist_releases.json"), null)
        assertEquals(Kind.SINGLE, untitled[1].kind)
    }

    @Test
    fun albumPlaylistIdFromAlbumBrowse() {
        assertEquals(
            "OLAK5uy_killersXXXXXXXXXXXXXXXXXXXXXXXXX",
            ArtistPage.albumPlaylistIdOf(fixture("album_browse.json")),
        )
        val noMicroformat = fixture("album_browse.json").apply { remove("microformat") }
        assertEquals("OLAK5uy_otherXXXXXXXXXXXXXXXXXXXXXXXXXXX", ArtistPage.albumPlaylistIdOf(noMicroformat))
        assertNull(ArtistPage.albumPlaylistIdOf(JSONObject()))
    }

    @Test
    fun emptyOrForeignPagesParseToNothing() {
        val p = ArtistPage.parseArtist(JSONObject("""{"contents":{"x":[1,2,{"y":null}]}}"""), "UCx")
        assertTrue(p.isEmpty)
        assertEquals("", p.name)
        assertNull(p.moreAlbums)
        assertNotNull(p.releases)
    }
}
