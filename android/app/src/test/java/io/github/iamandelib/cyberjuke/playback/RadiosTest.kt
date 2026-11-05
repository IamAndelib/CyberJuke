package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Test

class RadiosTest {
    @Test
    fun aRadiosFirstBatchIsTheTappedSongAloneInARadio() {
        assertEquals(true, Radios.firstBatch("radio", 1))
        assertEquals(false, Radios.firstBatch("radio", 2))
        assertEquals(false, Radios.firstBatch("list", 1))
        assertEquals(false, Radios.firstBatch(null, 1))
    }
}
