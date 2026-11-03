package io.github.iamandelib.cyberjuke.local

import io.github.iamandelib.cyberjuke.local.LocalRules.Relation
import io.github.iamandelib.cyberjuke.local.LocalRules.TreeRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalRulesTest {
    private val ext = "com.android.externalstorage.documents"
    private fun tree(docId: String, authority: String = ext) = TreeRef(authority, docId)

    @Test
    fun aFolderInsideOneAlreadyChosenIsInsideAndTheOtherWayRoundContains() {
        assertEquals(Relation.INSIDE, LocalRules.relation(tree("primary:Music/Rock"), tree("primary:Music")))
        assertEquals(Relation.INSIDE, LocalRules.relation(tree("primary:Music"), tree("primary:Music")))
        assertEquals(Relation.CONTAINS, LocalRules.relation(tree("primary:Music"), tree("primary:Music/Rock")))
        // A whole volume holds everything on it.
        assertEquals(Relation.CONTAINS, LocalRules.relation(tree("1A2B-3C4D:"), tree("1A2B-3C4D:Albums")))
    }

    @Test
    fun foldersThatOnlyShareAPrefixOrAreOnAnotherVolumeOrProviderDontOverlap() {
        assertEquals(Relation.NONE, LocalRules.relation(tree("primary:Musicals"), tree("primary:Music")))
        assertEquals(Relation.NONE, LocalRules.relation(tree("1A2B-3C4D:Music"), tree("primary:Music")))
        assertEquals(Relation.NONE, LocalRules.relation(tree("primary:Music/Rock", "other.provider"), tree("primary:Music")))
        // Another provider's opaque ids: only the same folder counts.
        assertEquals(Relation.INSIDE, LocalRules.relation(tree("abc", "p"), tree("abc", "p")))
        assertEquals(Relation.NONE, LocalRules.relation(tree("abc/d", "p"), tree("abc", "p")))
    }

    @Test
    fun songsAreKnownAudioByTypeOrExtensionAndNeverHidden() {
        assertTrue(LocalRules.isAudio("audio/mpeg", "a.mp3"))
        assertTrue(LocalRules.isAudio("audio/flac", "b"))
        assertTrue(LocalRules.isAudio("application/octet-stream", "c.OPUS"))
        assertTrue(LocalRules.isAudio(null, "d.m4a"))
        assertFalse(LocalRules.isAudio("audio/x-mpegurl", "list.m3u"))
        assertFalse(LocalRules.isAudio("audio/midi", "e.mid"))
        assertFalse(LocalRules.isAudio("image/jpeg", "cover.jpg"))
        assertFalse(LocalRules.isAudio("audio/mpeg", ".hidden.mp3"))
        assertTrue(LocalRules.isHidden(".thumbnails"))
    }

    @Test
    fun aFileIsReadAgainOnlyWhenNewOrChanged() {
        val e = LocalIndex.Entry("loc:0123456789abcdef", "t", "u", "a.mp3", "A", "B", "", 1000, 10, 20, false)
        assertTrue(LocalRules.needsRead(null, 10, 20))
        assertFalse(LocalRules.needsRead(e, 10, 20))
        assertTrue(LocalRules.needsRead(e, 11, 20))
        assertTrue(LocalRules.needsRead(e, 10, 21))
    }

    @Test
    fun idsAreStableForOneFileAndDifferForAnother() {
        val a = LocalRules.idOf(ext, "primary:Music/a.mp3")
        assertEquals(a, LocalRules.idOf(ext, "primary:Music/a.mp3"))
        assertNotEquals(a, LocalRules.idOf(ext, "primary:Music/b.mp3"))
        assertTrue(LocalRules.isId(a))
        assertFalse(LocalRules.isId("loc:xyz"))
        assertFalse(LocalRules.isId("yt:0123456789abcdef"))
    }

    @Test
    fun withoutTagsASongIsItsFileNameByUnknownArtist() {
        assertEquals("track07_final_v2", LocalRules.shownTitle(null, "track07_final_v2.mp3"))
        assertEquals("track07", LocalRules.shownTitle("  ", "track07"))
        assertEquals("Night Shift", LocalRules.shownTitle(" Night Shift ", "x.mp3"))
        assertEquals("Unknown artist", LocalRules.shownArtist(null, ""))
        assertEquals("The Low Hum", LocalRules.shownArtist("", "The Low Hum"))
        assertEquals("Kiri", LocalRules.shownArtist("Kiri", "Various"))
    }

    @Test
    fun aFoldersCoverIsPickedByNameInOrder() {
        assertEquals("Folder.JPG", LocalRules.coverName(listOf("a.mp3", "Folder.JPG", "front.jpg")))
        assertEquals("cover.png", LocalRules.coverName(listOf("folder.jpg", "cover.png")))
        assertNull(LocalRules.coverName(listOf("a.mp3", "art.jpg")))
    }
}
