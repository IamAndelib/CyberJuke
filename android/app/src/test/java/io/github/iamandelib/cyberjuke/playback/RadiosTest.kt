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

    @Test
    fun theNextListIsAskedForTheMomentNothingIsOnTheWay() {
        // As a list starts (an album, a batch moved on to), not when it nears its end: however many are left.
        assertEquals(true, Radios.needsNext(keepsGoing = true, mayAdd = true, nextStart = -1, count = 12, idle = false))
        // A list on the way already: nothing more until it starts.
        assertEquals(false, Radios.needsNext(keepsGoing = true, mayAdd = true, nextStart = 12, count = 37, idle = false))
        // Vibe off (and no station), Repeat all (but a radio's first batch), an empty player, a restored session before its first Play.
        assertEquals(false, Radios.needsNext(keepsGoing = false, mayAdd = true, nextStart = -1, count = 12, idle = false))
        assertEquals(false, Radios.needsNext(keepsGoing = true, mayAdd = false, nextStart = -1, count = 12, idle = false))
        assertEquals(false, Radios.needsNext(keepsGoing = true, mayAdd = true, nextStart = -1, count = 0, idle = false))
        assertEquals(false, Radios.needsNext(keepsGoing = true, mayAdd = true, nextStart = -1, count = 12, idle = true))
    }
}
