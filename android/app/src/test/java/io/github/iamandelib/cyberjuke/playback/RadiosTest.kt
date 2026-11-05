package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Test

class RadiosTest {
    @Test
    fun aRadiosFirstBatchIsTheTappedSongAloneInARadio() {
        assertEquals(true, Radios.firstBatch("radio", 1, 0))
        assertEquals(false, Radios.firstBatch("radio", 2, 0))
        assertEquals(false, Radios.firstBatch("list", 1, 0))
        assertEquals(false, Radios.firstBatch(null, 1, 0))
        // Songs you queued before the tap stay next (setList keeps them): they are not the radio's list.
        assertEquals(true, Radios.firstBatch("radio", 3, 2))
        assertEquals(false, Radios.firstBatch("radio", 3, 1))
    }
}
