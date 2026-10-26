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
        val track = "sig:cipher:wmin5WkOuPw"
        val station = "Signal Radio · CIPHER"
        assertEquals(true, Stations.keepsGoing(autoplayEnabled = false, seedId = track, contextLabel = station))
        assertEquals(true, Stations.keepsGoing(autoplayEnabled = true, seedId = track, contextLabel = station))
        // A station's track in another list (Recently played, Liked) is just a track there.
        assertEquals(false, Stations.keepsGoing(autoplayEnabled = false, seedId = track, contextLabel = "Recently played"))
        assertEquals(false, Stations.keepsGoing(autoplayEnabled = false, seedId = track, contextLabel = null))
        // Anything else stops at the end of its list with Autoplay off.
        assertEquals(false, Stations.keepsGoing(autoplayEnabled = false, seedId = "post0001", contextLabel = station))
        assertEquals(false, Stations.keepsGoing(autoplayEnabled = false, seedId = "ytm:wmin5WkOuPw", contextLabel = "Global"))
        assertEquals(true, Stations.keepsGoing(autoplayEnabled = true, seedId = "post0001", contextLabel = "Liked"))
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
