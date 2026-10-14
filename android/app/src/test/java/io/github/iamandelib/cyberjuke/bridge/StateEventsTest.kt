package io.github.iamandelib.cyberjuke.bridge

import androidx.media3.common.Player
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StateEventsTest {
    private fun changes(vararg events: Int) = StateEvents.changeState(events.size) { events[it] }

    @Test
    fun aCrossfadesVolumeStepSendsNoState() {
        assertFalse(changes(Player.EVENT_VOLUME_CHANGED))
    }

    @Test
    fun anythingElseDoes() {
        assertTrue(changes(Player.EVENT_IS_PLAYING_CHANGED))
        assertTrue(changes(Player.EVENT_VOLUME_CHANGED, Player.EVENT_MEDIA_ITEM_TRANSITION))
        assertTrue(changes(Player.EVENT_TIMELINE_CHANGED, Player.EVENT_VOLUME_CHANGED))
    }
}
