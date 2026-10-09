package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.playback.NativeQueue.Section
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
    fun anythingBrokenIsDroppedNotHalfRestored() {
        val good = JSONObject(session(3, 0).encode())
        assertNull(LastSession.decode("not json"))
        assertNull(LastSession.decode("{}"))
        assertNull(LastSession.decode(JSONObject(good.toString()).put("v", 2).toString()))
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
}
