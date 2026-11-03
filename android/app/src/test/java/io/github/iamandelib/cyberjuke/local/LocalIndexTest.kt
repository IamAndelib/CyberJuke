package io.github.iamandelib.cyberjuke.local

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class LocalIndexTest {
    private fun dir(): File = Files.createTempDirectory("local").toFile()

    private fun entry(n: Int, folder: String = "tree-a") =
        LocalIndex.Entry("loc:000000000000000$n", folder, "content://x/$n", "$n.mp3", "Song $n", "Artist", "Album", 1000L * n, 10L * n, 20L * n, n % 2 == 0)

    @Test
    fun theFoldersAndSongsSurviveASaveAndALoad() {
        val d = dir()
        val a = LocalIndex(d)
        a.folders += LocalIndex.Folder("tree-a", "Music")
        a.entries[entry(1).id] = entry(1)
        a.entries[entry(2).id] = entry(2)
        a.save()
        val b = LocalIndex(d).apply { load() }
        assertEquals(listOf(LocalIndex.Folder("tree-a", "Music")), b.folders)
        assertEquals(listOf(entry(1), entry(2)), b.entries.values.toList())
        assertFalse(File(d, "index.json.tmp").exists())
    }

    @Test
    fun aBrokenFileOrAnotherVersionReadsAsEmpty() {
        assertNull(LocalIndex.decode("{not json"))
        assertNull(LocalIndex.decode("""{"version":2,"folders":[],"songs":[]}"""))
        val d = dir()
        File(d, "index.json").writeText("garbage")
        val i = LocalIndex(d).apply { load() }
        assertTrue(i.folders.isEmpty() && i.entries.isEmpty())
    }

    @Test
    fun aSongWithABadIdOrOfAFolderNoLongerChosenIsDropped() {
        val text = LocalIndex.encode(listOf(LocalIndex.Folder("tree-a", "Music")), listOf(entry(1), entry(2, "tree-gone"), entry(3).copy(id = "loc:bad")))
        val (_, songs) = LocalIndex.decode(text)!!
        assertEquals(listOf(entry(1)), songs)
    }

    @Test
    fun removingAFolderDropsItsSongsAndCoversOnly() {
        val d = dir()
        val i = LocalIndex(d)
        i.folders += LocalIndex.Folder("tree-a", "Music")
        i.folders += LocalIndex.Folder("tree-b", "Albums")
        listOf(entry(1), entry(2, "tree-b")).forEach { i.entries[it.id] = it }
        i.artFile(entry(1).id).apply { parentFile!!.mkdirs(); writeText("jpg") }
        i.removeFolder("tree-a")
        assertEquals(listOf("tree-b"), i.folders.map { it.id })
        assertEquals(listOf(entry(2, "tree-b").id), i.entries.keys.toList())
        assertFalse(i.artFile(entry(1).id).exists())
        assertEquals(1, i.songsIn("tree-b"))
    }

    @Test
    fun clearLeavesNothingBehind() {
        val d = dir()
        val i = LocalIndex(d)
        i.folders += LocalIndex.Folder("tree-a", "Music")
        i.entries[entry(1).id] = entry(1)
        i.save()
        i.clear()
        assertFalse(d.exists())
        assertTrue(i.folders.isEmpty() && i.entries.isEmpty())
    }
}
