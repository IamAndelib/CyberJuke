package io.github.iamandelib.cyberjuke.playback

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QueueInfoTest {
    @After
    fun tearDown() = QueueInfo.clearLow()

    @Test
    fun aSignalRadioStationPlaysOnWhateverTheAutoplaySetting() {
        assertEquals(true, Stations.keepsGoing(autoplayEnabled = false, seedId = "sig:cipher:wmin5WkOuPw"))
        assertEquals(true, Stations.keepsGoing(autoplayEnabled = true, seedId = "sig:cipher:wmin5WkOuPw"))
        // Anything else stops at the end of its list with Autoplay off.
        assertEquals(false, Stations.keepsGoing(autoplayEnabled = false, seedId = "post0001"))
        assertEquals(false, Stations.keepsGoing(autoplayEnabled = false, seedId = "ytm:wmin5WkOuPw"))
        assertEquals(false, Stations.keepsGoing(autoplayEnabled = false, seedId = null))
        assertEquals(true, Stations.keepsGoing(autoplayEnabled = true, seedId = "post0001"))
    }

    @Test
    fun aRunningLowIsKeptUntilAnswered() {
        // Said while the app was swiped away: the service won't say it again for this state,
        // so the plugin repeats lastLow to the page's next queueLow listener.
        val heard = ArrayList<String>()
        val l = QueueInfo.QueueLowListener { left, seed -> heard.add("$left $seed") }
        QueueInfo.emitQueueLow(2, "seed")
        assertEquals(2 to "seed", QueueInfo.lastLow)
        QueueInfo.addLow(l)
        assertEquals(emptyList<String>(), heard) // no replay here: nothing in the page listens yet
        QueueInfo.emitQueueLow(1, "seed")
        assertEquals(listOf("1 seed"), heard)
        // Answered (enough ahead again): nothing to repeat.
        QueueInfo.clearLow()
        assertNull(QueueInfo.lastLow)
        QueueInfo.removeLow(l)
    }
}
