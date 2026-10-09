package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RadioFeederTest {
    private val r = RadioFeeder.State("seed", null)

    @Test
    fun theNextPageOfTheSameRadio() {
        assertEquals(RadioFeeder.State("seed", "tok"), RadioFeeder.afterPage(r, next = "tok", newLast = "b", pageLast = "b"))
    }

    @Test
    fun atTheEndANewRadioFromItsLastSong() {
        assertEquals(RadioFeeder.State("b", null), RadioFeeder.afterPage(r, next = null, newLast = "b", pageLast = "c"))
    }

    @Test
    fun aLastPageOfDuplicatesStillGoesOnFromItsLastSong() {
        // Everything on it is in the player already: a new radio, not a silent stop.
        assertEquals(RadioFeeder.State("c", null), RadioFeeder.afterPage(r, next = null, newLast = null, pageLast = "c"))
    }

    @Test
    fun stopsOnlyWhenThereIsNothingToGoOnFrom() {
        assertNull(RadioFeeder.afterPage(r, next = null, newLast = null, pageLast = null))
        // Its last song is the seed itself: the same radio again would bring the same songs.
        assertNull(RadioFeeder.afterPage(r, next = null, newLast = null, pageLast = "seed"))
    }
}
