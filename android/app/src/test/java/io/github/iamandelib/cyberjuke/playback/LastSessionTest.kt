package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.playback.NativeQueue.Section
import io.github.iamandelib.cyberjuke.yt.YtMusic
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The saved session (what the app reopens on after a restart): codec, window and validation. */
class LastSessionTest {

    private fun yt(i: Int) = "video${i.toString().padStart(6, '0')}" // 11 characters

    private fun entry(i: Int, section: Section = Section.LIST) = LastSession.Entry(
        id = "t$i", ytId = yt(i), title = "Title $i", artist = "Artist $i",
        artworkUrl = "https://i.ytimg.com/vi/${yt(i)}/hqdefault.jpg", by = "poster$i", postUrl = null, section = section,
    )

    private fun session(n: Int, index: Int, order: IntArray? = null) = LastSession.of(
        (0 until n).map { entry(it, if (it == n - 1) Section.AUTO else if (it == index + 1) Section.QUEUED else Section.LIST) },
        index, 61_000L, 200_000L, shuffle = order != null, order = order, repeat = 2,
        context = "Liked" to "list", seedId = "t0",
    )!!

    @Test
    fun roundTrips() {
        val s = session(6, 2, intArrayOf(2, 3, 0, 5, 1, 4))
        val back = LastSession.decode(s.encode())
        assertEquals(s, back)
        assertEquals(Section.QUEUED, back!!.entries[3].section)
        assertEquals(Section.AUTO, back.entries[5].section)
        assertEquals("Liked" to "list", back.context)
    }

    @Test
    fun anAlbumTrackKeepsItsAlbum() {
        // Crossfade's same-album rule reads the album back after a restart; a track without one has none.
        val s = LastSession.of(listOf(entry(0).copy(album = "Blue Lines"), entry(1)), 0, 0L, 0L, false, null, 0, null, null)!!
        val back = LastSession.decode(s.encode())!!
        assertEquals(listOf("Blue Lines", null), back.entries.map { it.album })
        assertEquals("Blue Lines", back.entries[0].toNativeTrack().getString("album"))
        assertEquals(false, back.entries[1].toNativeTrack().has("album"))
        // An album that isn't a string is no album.
        val odd = JSONObject(s.encode())
        odd.getJSONArray("tracks").getJSONObject(0).put("album", 7)
        assertNull(LastSession.decode(odd.toString())!!.entries[0].album)
    }

    @Test
    fun aGlobalSongKeepsItsArtists() {
        // Its artist page opens by channel after a restart too; a track without them has none.
        val credits = listOf(YtMusic.Credit("Bill Withers", "UCDjpW6k2Sfg_FTr1toLvffQ"), YtMusic.Credit("Grover Washington, Jr.", "UCsN1HTruhFfXcSMGMsBmX_w"))
        val s = LastSession.of(listOf(entry(0).copy(artists = credits), entry(1)), 0, 0L, 0L, false, null, 0, null, null)!!
        val back = LastSession.decode(s.encode())!!
        assertEquals(listOf(credits, emptyList()), back.entries.map { it.artists })
        assertEquals("Grover Washington, Jr.", back.entries[0].toNativeTrack().getJSONArray("artists").getJSONObject(1).getString("name"))
        assertEquals(false, back.entries[1].toNativeTrack().has("artists"))
    }

    @Test
    fun aMembersOnlyTrackStaysMembersOnly() {
        val s = LastSession.of(listOf(entry(0).copy(membersOnly = true), entry(1)), 0, 0L, 0L, false, null, 0, null, null)!!
        val back = LastSession.decode(s.encode())!!
        assertEquals(listOf(true, false), back.entries.map { it.membersOnly })
        assertEquals(true, back.entries[0].toNativeTrack().optBoolean("membersOnly"))
        assertEquals(false, back.entries[1].toNativeTrack().has("membersOnly"))
    }

    @Test
    fun aJukeboxMp3ComesBackAsAnMp3() {
        // An MP3 has no video id: the session keeps its latex.gg link instead (it used to be
        // dropped whole, the moment one MP3 was in the list).
        val link = "https://latex.gg/share/IZq8cMcx.mp3"
        val mp3 = entry(1).copy(ytId = "", mp3 = link, artworkUrl = "https://bunker.cyberspace.online/uploads/jukebox/x/1.jpg")
        val s = LastSession.of(listOf(entry(0), mp3), 1, 5_000L, 0L, false, null, 0, null, null)!!
        val back = LastSession.decode(s.encode())!!
        assertEquals(s, back)
        assertEquals(listOf(null, link), back.entries.map { it.mp3 })
        val track = back.entries[1].toNativeTrack()
        assertEquals(link, track.getString("mp3"))
        assertEquals("", track.getString("ytId"))
        assertEquals(false, back.entries[0].toNativeTrack().has("mp3"))
        // Only a latex.gg share link: anything else in its place drops the session.
        for (bad in listOf("https://evil.example/x.mp3", "file:///sdcard/x.mp3", "")) {
            val o = JSONObject(s.encode())
            o.getJSONArray("tracks").getJSONObject(1).put("mp3", bad)
            assertNull(bad, LastSession.decode(o.toString()))
        }
        // A video id wins over a stray link: the entry is the video's.
        val both = JSONObject(s.encode())
        both.getJSONArray("tracks").getJSONObject(0).put("mp3", link)
        assertNull(LastSession.decode(both.toString())!!.entries[0].mp3)
    }

    @Test
    fun aLongListKeepsAWindowAroundTheCurrentTrack() {
        val n = 2000
        val order = IntArray(n) { n - 1 - it }
        val s = session(n, 1500, order)
        assertEquals(LastSession.MAX_ENTRIES, s.entries.size)
        // 100 before the current one, the rest after it.
        assertEquals("t1400", s.entries.first().id)
        assertEquals(100, s.index)
        assertEquals("t1500", s.entries[s.index].id)
        // The shuffle order keeps the window's tracks, in its order, renumbered.
        assertEquals(LastSession.MAX_ENTRIES, s.order!!.size)
        assertEquals(LastSession.MAX_ENTRIES - 1, s.order[0])
        assertEquals(0, s.order.last())
        // Near the start, the window starts at 0.
        assertEquals("t0", session(n, 30).entries.first().id)
        assertEquals(30, session(n, 30).index)
    }

    @Test
    fun aNewerPositionAppliesOnlyToTheTrackItWasFor() {
        val s = session(4, 1)
        val moved = s.withPosition(2, "t2", 5_000L, 180_000L)
        assertEquals(2, moved.index)
        assertEquals(5_000L, moved.positionMs)
        assertEquals(180_000L, moved.durationMs)
        // Same track, length not known yet: the saved one stays.
        assertEquals(200_000L, s.withPosition(1, "t1", 9_000L, 0L).durationMs)
        // A different track at that index (the list changed since): ignored.
        assertEquals(s, s.withPosition(2, "t9", 5_000L, 0L))
        assertEquals(s, s.withPosition(99, "t2", 5_000L, 0L))
    }

    @Test
    fun aPositionInALongListAppliesToTheTrackInTheWindow() {
        // The player saves its index in the whole list; the file keeps a window of it.
        val s = LastSession.decode(session(2000, 1500).copy(savedAtMs = 1_000L).encode())!!
        val pref = LastSession.positionPref(1501, "t1501", 42_000L, 190_000L, savedAtMs = 2_000L)
        val back = s.withPositionPref(pref)
        assertEquals("t1501", back.entries[back.index].id)
        assertEquals(42_000L, back.positionMs)
        // Near the start (no offset), the same.
        val start = session(2000, 3).copy(savedAtMs = 1_000L)
        assertEquals(4, start.withPositionPref(LastSession.positionPref(4, "t4", 1_000L, 0L, 2_000L)).index)
    }

    @Test
    fun onlyAPositionSavedNoEarlierThanTheListApplies() {
        val s = session(4, 1).copy(savedAtMs = 1_000L)
        // Saved later, same track: applies.
        val later = LastSession.positionPref(2, "t2", 42_000L, 190_000L, savedAtMs = 2_000L)
        assertEquals(2, s.withPositionPref(later).index)
        assertEquals(42_000L, s.withPositionPref(later).positionMs)
        // Saved before this list was (an earlier play of the same list): the list's position wins.
        val earlier = LastSession.positionPref(2, "t2", 42_000L, 190_000L, savedAtMs = 999L)
        assertEquals(s, s.withPositionPref(earlier))
        // Missing, malformed, or the old four-field format: ignored.
        assertEquals(s, s.withPositionPref(null))
        assertEquals(s, s.withPositionPref("2|42000|190000|t2"))
        assertEquals(s, s.withPositionPref("x|42000|190000|2000|t2"))
        // An id with the separator in it still matches.
        val odd = LastSession.of(listOf(entry(0).copy(id = "a|b")), 0, 0L, 0L, false, null, 0, null, null, savedAtMs = 5L)!!
        assertEquals(7_000L, odd.withPositionPref(LastSession.positionPref(0, "a|b", 7_000L, 0L, 6L)).positionMs)
        // The save time round-trips.
        assertEquals(1_000L, LastSession.decode(s.encode())!!.savedAtMs)
    }

    @Test
    fun theListMarkersRoundTrip() {
        val s = LastSession.of((0 until 6).map { entry(it) }, 3, 0L, 0L, false, null, 0, null, null, listStart = 2, nextStart = 5)!!
        val back = LastSession.decode(s.encode())!!
        assertEquals(2 to 5, back.listStart to back.nextStart)
        assertEquals(s, back)
        val none = LastSession.decode(session(3, 0).encode())!!
        assertEquals(0 to -1, none.listStart to none.nextStart)
    }

    @Test
    fun aVersion1FileHasNoMarkersSoTheListStartsAtZeroAndAutoplayAtItsFirstEntry() {
        val old = JSONObject(session(6, 2).encode()).put("v", 1)
        old.remove("listStart")
        old.remove("nextStart")
        val back = LastSession.decode(old.toString())!!
        assertEquals(0 to 5, back.listStart to back.nextStart) // session(): the last entry is autoplay
        val noAuto = JSONObject(old.toString())
        noAuto.getJSONArray("tracks").getJSONObject(5).put("k", "l")
        assertEquals(-1, LastSession.decode(noAuto.toString())!!.nextStart)
        // A marker that points nowhere in a version 2 file is read as none.
        val bad = JSONObject(session(3, 0).encode()).put("listStart", 9).put("nextStart", 9)
        assertEquals(0 to -1, LastSession.decode(bad.toString())!!.let { it.listStart to it.nextStart })
    }

    @Test
    fun markersOutsideTheSavedWindowAreClamped() {
        val all = (0 until 1000).map { entry(it) }
        // Window 400..899 around 500: the list start before it is its first entry, autoplay after it is none.
        val s = LastSession.of(all, 500, 0L, 0L, false, null, 0, null, null, listStart = 10, nextStart = 950)!!
        assertEquals(400, s.offset)
        assertEquals(0 to -1, s.listStart to s.nextStart)
        // Inside it, they are window indices; autoplay before it starts at the first entry.
        val inside = LastSession.of(all, 500, 0L, 0L, false, null, 0, null, null, listStart = 450, nextStart = 600)!!
        assertEquals(50 to 200, inside.listStart to inside.nextStart)
        assertEquals(0, LastSession.of(all, 500, 0L, 0L, false, null, 0, null, null, listStart = 300, nextStart = 350)!!.nextStart)
    }

    @Test
    fun anythingBrokenIsDroppedNotHalfRestored() {
        val good = JSONObject(session(3, 0).encode())
        assertNull(LastSession.decode("not json"))
        assertNull(LastSession.decode("{}"))
        assertNull(LastSession.decode(JSONObject(good.toString()).put("v", 3).toString()))
        assertNull(LastSession.decode(JSONObject(good.toString()).put("index", 3).toString()))
        val badTrack = JSONObject(good.toString())
        badTrack.getJSONArray("tracks").getJSONObject(1).put("ytId", "https://evil")
        assertNull(LastSession.decode(badTrack.toString()))
        val noId = JSONObject(good.toString())
        noId.getJSONArray("tracks").getJSONObject(0).remove("id")
        assertNull(LastSession.decode(noId.toString()))
        // A shuffle order that doesn't fit is just left out.
        val badOrder = JSONObject(good.toString()).put("order", org.json.JSONArray(listOf(0, 0, 1)))
        assertNull(LastSession.decode(badOrder.toString())!!.order)
        // A track only this build may play (the CI tone in debug builds).
        val tone = JSONObject(good.toString())
        tone.getJSONArray("tracks").getJSONObject(0).put("ytId", "ci-tone")
        assertNull(LastSession.decode(tone.toString()))
        assertEquals("ci-tone", LastSession.decode(tone.toString()) { it == "ci-tone" || SessionPolicy.isValidYtId(it) }!!.entries[0].ytId)
    }

    @Test
    fun nothingToSaveForAnEmptyList() {
        assertNull(LastSession.of(emptyList(), 0, 0L, 0L, false, null, 0, null, null))
    }

    @Test
    fun theQueueComesBackWithItsPartsAndShuffleOrder() {
        for (seed in 0L until 20L) {
            val p = QueueRulesTest.FakePlayer(java.util.Random(seed))
            p.shuffle = true
            val ids = listOf("a", "b", "c", "q1", "q2", "s1", "s2")
            val sections = listOf(Section.LIST, Section.LIST, Section.LIST, Section.QUEUED, Section.QUEUED, Section.AUTO, Section.AUTO)
            // Played: b; current a; then the queued ones, then c, then autoplay.
            val order = intArrayOf(1, 0, 3, 4, 2, 5, 6)
            p.queue.restoreSession(ids, sections, start = 0, positionMs = 61_000L, order = order)
            assertEquals("a", p.ids[p.current])
            assertEquals("seed $seed", listOf("q1", "q2", "c", "s1", "s2"), p.upNext())
            assertEquals(2, p.queue.pendingSerials.size)
            assertEquals(listOf(false, false, false, false, false, true, true), p.auto.toList())
            assertArrayEquals(order, p.shuffleOrder())
            // The queued ones are "queued by you" again: they stay next across a new list.
            p.queue.setList(listOf("x", "y"), 0)
            assertEquals(listOf("q1", "q2", "y"), p.upNext())
        }
    }

    @Test
    fun whatWasHeardComesBackAsPlayed() {
        // Started at c: a and b were never heard; c and d were, and e plays.
        val s = LastSession.of(
            (0 until 5).map { entry(it).copy(heard = it in 2..4) },
            4, 0L, 0L, false, null, 0, null, null,
        )!!
        val back = LastSession.decode(s.encode())!!
        assertEquals(listOf(false, false, true, true, true), back.entries.map { it.heard })
        val p = QueueRulesTest.FakePlayer(java.util.Random(1))
        p.queue.restoreSession(back.entries.map { it.id }, back.entries.map { it.section }, back.index, 0L, null, back.entries.map { it.heard })
        assertEquals(listOf("t2", "t3"), p.played())
        // A file from before "heard": what was before the current one, as Played showed then.
        val old = JSONObject(s.encode())
        val tracks = old.getJSONArray("tracks")
        for (i in 0 until tracks.length()) tracks.getJSONObject(i).remove("h")
        assertEquals(listOf(true, true, true, true, true), LastSession.decode(old.toString())!!.entries.map { it.heard })
    }

    @Test
    fun theQueuedByYouMarkComesBack() {
        // Rule 8: a song you queued keeps the mark after it played, and after a restart too.
        val s = LastSession.of(listOf(entry(0).copy(mine = true, heard = true), entry(1)), 0, 0L, 0L, false, null, 0, null, null)!!
        val back = LastSession.decode(s.encode())!!
        assertEquals(s, back)
        assertEquals(listOf(true, false), back.entries.map { it.mine })
        // Still version 2: an older app reads the file and ignores the mark.
        val o = JSONObject(s.encode())
        assertEquals(2, o.getInt("v"))
        // A file from before the mark has none.
        val tracks = o.getJSONArray("tracks")
        for (i in 0 until tracks.length()) tracks.getJSONObject(i).remove("m")
        assertEquals(listOf(false, false), LastSession.decode(o.toString())!!.entries.map { it.mine })
    }

    @Test
    fun saveMemoryOfTheSongsYouQueuedComesBack() {
        // Rule 8: the songs you queued that played, also those Repeat all took out of the queue, with the song before each.
        val memory = listOf(LastSession.Heard(entry(7), "t0"), LastSession.Heard(entry(8).copy(ytId = "", mp3 = "https://latex.gg/share/IZq8cMcx.mp3"), null))
        val s = LastSession.of(listOf(entry(0), entry(1)), 1, 0L, 0L, false, null, 2, null, null, heardMine = memory)!!
        val back = LastSession.decode(s.encode())!!
        assertEquals(s, back)
        assertEquals(memory, back.heardMine)
        // A record of a song it can't play is left out; the session still comes back.
        val bad = JSONObject(s.encode())
        bad.getJSONArray("hm").put(entry(9).copy(ytId = "short").toNativeTrack().put("after", "t8"))
        assertEquals(memory, LastSession.decode(bad.toString())!!.heardMine)
        // Still version 2, and a file from before the memory has none.
        val o = JSONObject(s.encode())
        assertEquals(2, o.getInt("v"))
        o.remove("hm")
        assertEquals(emptyList<LastSession.Heard>(), LastSession.decode(o.toString())!!.heardMine)
        // The player keeps it: what Save reads after a restart.
        val p = QueueRulesTest.FakePlayer(java.util.Random(1))
        p.queue.restoreSession(back.entries.map { it.id }, back.entries.map { it.section }, back.index, 0L, null, heardMine = back.heardMine.map { NativeQueue.Heard(it.entry.id, it.entry.id, it.after) })
        assertEquals(listOf("t7" to "t0", "t8" to null), p.queue.heardMine.map { it.id to it.after })
    }

    @Test
    fun aShuffledFileFromBeforeHeardMarksWhatPlayedInItsOrder() {
        // Play order 3, 0, 4 (current), 1, 2: 3 and 0 played; 1 and 2 are still to come.
        val s = LastSession.of((0 until 5).map { entry(it) }, 4, 0L, 0L, true, intArrayOf(3, 0, 4, 1, 2), 0, null, null)!!
        val old = JSONObject(s.encode())
        val tracks = old.getJSONArray("tracks")
        for (i in 0 until tracks.length()) tracks.getJSONObject(i).remove("h")
        assertEquals(listOf(true, false, false, true, true), LastSession.decode(old.toString())!!.entries.map { it.heard })
    }

    @Test
    fun withoutShuffleTheQueuedOnesStayRightAfterTheCurrentTrack() {
        val p = QueueRulesTest.FakePlayer(java.util.Random(1))
        val ids = listOf("a", "b", "q1", "c", "s1")
        val sections = listOf(Section.LIST, Section.LIST, Section.QUEUED, Section.LIST, Section.AUTO)
        p.queue.restoreSession(ids, sections, start = 1, positionMs = 0L, order = null)
        assertEquals("b", p.ids[p.current])
        assertEquals(listOf("q1", "c", "s1"), p.upNext())
        assertEquals(1, p.queue.pendingSerials.size)
        // A queued item that is the current one is just the current one.
        val p2 = QueueRulesTest.FakePlayer(java.util.Random(1))
        p2.queue.restoreSession(listOf("q1", "a"), listOf(Section.QUEUED, Section.LIST), 0, 0L, null)
        assertEquals(0, p2.queue.pendingSerials.size)
    }

    @Test
    fun aLocalSongComesBackByItsIdOnly() {
        val local = entry(1).copy(id = "loc:0123456789abcdef", ytId = "", artworkUrl = null, local = true)
        val s = LastSession.of(listOf(entry(0), local), 1, 5_000L, 0L, false, null, 0, null, null)!!
        val back = LastSession.decode(s.encode())!!
        assertEquals(s, back)
        val track = back.entries[1].toNativeTrack()
        assertEquals(true, track.getBoolean("local"))
        assertEquals("", track.getString("ytId"))
        assertEquals(false, track.has("mp3"))
        assertEquals(false, back.entries[0].toNativeTrack().has("local"))
        // A local entry with an id that isn't a local song's drops the session.
        val o = JSONObject(s.encode())
        o.getJSONArray("tracks").getJSONObject(1).put("id", "t1")
        assertNull(LastSession.decode(o.toString()))
    }
}
