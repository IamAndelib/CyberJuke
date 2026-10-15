package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FormatKeepTest {
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
    fun aSavedCopyMustBeTheServedFileWhenOneFileWillDo() {
        assertTrue(FormatKeep.mustKeep(kept = true, midStream = false))
        assertTrue(FormatKeep.mustKeep(kept = false, midStream = true))
        assertFalse(FormatKeep.mustKeep(kept = false, midStream = false))
    }
}
