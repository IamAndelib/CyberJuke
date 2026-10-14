package io.github.iamandelib.cyberjuke.bridge

import androidx.media3.common.C
import androidx.media3.common.Player
import org.junit.Assert.assertEquals
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

    @Test
    fun bufferedAheadIsWhatIsLoadedPastThePosition() {
        assertEquals(30_000L, StateEvents.bufferedAheadMs(bufferedMs = 100_000L, positionMs = 70_000L))
        // A restored session not loaded yet: buffered where it is.
        assertEquals(0L, StateEvents.bufferedAheadMs(bufferedMs = 70_000L, positionMs = 70_000L))
        assertEquals(0L, StateEvents.bufferedAheadMs(bufferedMs = 60_000L, positionMs = 70_000L))
    }

    @Test
    fun anUnknownBufferIsNone() {
        // C.TIME_UNSET minus a position would wrap around to a huge positive number.
        assertEquals(0L, StateEvents.bufferedAheadMs(bufferedMs = C.TIME_UNSET, positionMs = 70_000L))
        assertEquals(0L, StateEvents.bufferedAheadMs(bufferedMs = 0L, positionMs = 0L))
        assertEquals(5_000L, StateEvents.bufferedAheadMs(bufferedMs = 5_000L, positionMs = C.TIME_UNSET))
    }
}
