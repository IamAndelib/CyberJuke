package io.github.iamandelib.cyberjuke.playback

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

class QueueInfoTest {
    @After
    fun tearDown() = QueueInfo.clearLow()

    @Test
    fun aRunningLowNobodyHeardReachesTheNextListener() {
        // Said while the app was swiped away: the service won't say it again for this state.
        QueueInfo.emitQueueLow(2, "seed")
        val heard = ArrayList<String>()
        val l = QueueInfo.QueueLowListener { left, seed -> heard.add("$left $seed") }
        QueueInfo.addLow(l)
        assertEquals(listOf("2 seed"), heard)
        // Answered (enough ahead again): a later listener hears nothing.
        QueueInfo.removeLow(l)
        QueueInfo.clearLow()
        QueueInfo.addLow(l)
        assertEquals(listOf("2 seed"), heard)
        QueueInfo.removeLow(l)
    }
}
