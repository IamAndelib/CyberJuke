package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FormatKeepTest {
    private val opus = CacheKeys.of("dQw4w9WgXcQ", 251, 3_000_000L)
    private val aac = CacheKeys.of("dQw4w9WgXcQ", 140, 3_500_000L)

    @Test
    fun aKeptFormatBeatsAResumesServedFile() {
        assertEquals(251, FormatKeep.itag(kept = 251, midStream = true, servedItag = 140))
        assertEquals(251, FormatKeep.itag(kept = 251, midStream = false, servedItag = null))
        assertEquals(140, FormatKeep.itag(kept = null, midStream = true, servedItag = 140))
        // A load from the start, nothing kept: any rung.
        assertNull(FormatKeep.itag(kept = null, midStream = false, servedItag = 140))
        assertNull(FormatKeep.itag(kept = null, midStream = true, servedItag = -1))
    }

    @Test
    fun anAskedItagNeedsTheServedFileInThatFormatWhateverIsKept() {
        // The tail's itag: one file only, even from the start and with nothing kept ...
        assertTrue(FormatKeep.mustKeep(asked = 251, kept = false, midStream = false))
        // ... and only if the served file is of it, even when a format is kept or it resumes.
        for ((kept, mid) in listOf(true to true, false to true, true to false, false to false)) {
            assertTrue(FormatKeep.mustKeep(asked = 140, kept = kept, midStream = mid))
            assertNull(FormatKeep.keepKey(asked = 140, servedKey = opus))
        }
    }

    @Test
    fun aSavedCopyMustBeTheServedFileWhenOneFileWillDo() {
        assertTrue(FormatKeep.mustKeep(asked = 251, kept = false, midStream = false))
        assertTrue(FormatKeep.mustKeep(asked = null, kept = true, midStream = false))
        assertTrue(FormatKeep.mustKeep(asked = null, kept = false, midStream = true))
        assertFalse(FormatKeep.mustKeep(asked = null, kept = false, midStream = false))
    }

    @Test
    fun anAskedItagTheServedFileIsntOfMeansNoSavedCopy() {
        // The tail asks for 251 but the served file is the 140 one: no copy will do.
        assertNull(FormatKeep.keepKey(asked = 251, servedKey = aac))
        assertEquals(opus, FormatKeep.keepKey(asked = 251, servedKey = opus))
        // Nothing asked: the served file, whatever its format.
        assertEquals(aac, FormatKeep.keepKey(asked = null, servedKey = aac))
        assertNull(FormatKeep.keepKey(asked = 251, servedKey = null))
    }
}
