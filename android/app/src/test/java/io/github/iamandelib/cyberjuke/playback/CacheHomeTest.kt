package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.playback.CacheHome.Step
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class CacheHomeTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun movesOnlyWhatIsOnlyInTheOldHome() {
        assertEquals(Step.MIGRATE, CacheHome.plan(oldExists = true, newExists = false))
        assertEquals(Step.FRESH, CacheHome.plan(oldExists = false, newExists = false))
        // Already moved: the new home wins, whatever is left in the old one.
        assertEquals(Step.IN_PLACE, CacheHome.plan(oldExists = false, newExists = true))
        assertEquals(Step.IN_PLACE, CacheHome.plan(oldExists = true, newExists = true))
    }

    @Test
    fun theFolderAndBothListsMoveWholeWithTheUidFile() {
        val (old, new) = homes()
        File(old, "audio/7").mkdirs()
        File(old, "audio/1234abcd.uid").writeText("")
        File(old, "audio/7/0.0.1.v3.exo").writeText("song")
        File(old, "audio-liked").writeText("dQw4w9WgXcQ")
        File(old, "audio-members").writeText("abcdefghijk")
        val deleted = ArrayList<File>()

        assertTrue(CacheHome.move(old, new, { deleted.add(it) }))

        assertTrue(File(new, "audio/1234abcd.uid").isFile)
        assertEquals("song", File(new, "audio/7/0.0.1.v3.exo").readText())
        assertEquals("dQw4w9WgXcQ", File(new, "audio-liked").readText())
        assertEquals("abcdefghijk", File(new, "audio-members").readText())
        for (name in CacheHome.NAMES) assertFalse(name, File(old, name).exists())
        assertTrue(deleted.isEmpty())
    }

    @Test
    fun onceMovedTheNewHomeStaysAndALeftoverOldCopyGoes() {
        val (old, new) = homes()
        File(new, "audio").mkdirs()
        File(new, "audio/new.uid").writeText("")
        File(new, "audio-liked").writeText("new")
        File(old, "audio").mkdirs()
        File(old, "audio-liked").writeText("old")
        val deleted = ArrayList<File>()

        assertTrue(CacheHome.move(old, new, { deleted.add(it); it.deleteRecursively() }))

        assertTrue(File(new, "audio/new.uid").isFile)
        assertEquals("new", File(new, "audio-liked").readText())
        // The folder through deleteDir (its index goes too), the list file directly.
        assertEquals(listOf(File(old, "audio")), deleted)
        assertFalse(File(old, "audio").exists())
        assertFalse(File(old, "audio-liked").exists())
    }

    @Test
    fun nothingAnywhereStartsEmpty() {
        val (old, new) = homes()
        assertTrue(CacheHome.move(old, new, { error("nothing to delete") }))
        for (name in CacheHome.NAMES) assertFalse(name, File(new, name).exists())
    }

    @Test
    fun aRenameThatFailsDeletesTheOldCopyAndStartsEmpty() {
        val (old, new) = homes()
        File(old, "audio").mkdirs()
        File(old, "audio-liked").writeText("dQw4w9WgXcQ")
        val deleted = ArrayList<File>()

        assertFalse(CacheHome.move(old, new, { deleted.add(it); it.deleteRecursively() }, rename = { _, _ -> false }))

        assertEquals(listOf(File(old, "audio")), deleted)
        for (name in CacheHome.NAMES) {
            assertFalse(name, File(old, name).exists())
            assertFalse(name, File(new, name).exists())
        }
    }

    /** The old home (cacheDir) and the new one (noBackupFilesDir), both there as on the phone. */
    private fun homes(): Pair<File, File> = tmp.newFolder("cache") to tmp.newFolder("no_backup")
}
