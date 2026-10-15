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

    private fun waiting(
        count: Int = 3,
        isPlaying: Boolean = false,
        playWhenReady: Boolean = true,
        buffering: Boolean = true,
        outagePause: Boolean = false,
        validated: Boolean = false,
    ) = WaitingRule.waiting(count, isPlaying, playWhenReady, buffering, outagePause, validated)

    @Test
    fun theMusicWaitsForTheCarrierAsSoonAsItStallsWithoutAValidatedNetwork() {
        // Play wanted, buffering, no validated network: waiting now, not once the retries ran out.
        assertTrue(waiting())
        // The same stall on a validated network is a slow connection, not a wait for the carrier.
        assertFalse(waiting(validated = true))
        // Paused during the stall (the user, or an outage pause that hasn't registered yet): no.
        assertFalse(waiting(playWhenReady = false))
        // Ready while the network is gone: the buffer plays on, nothing waits.
        assertFalse(waiting(buffering = false))
        // During a handover the player may be ready and playing with the old network gone.
        assertFalse(waiting(isPlaying = true, buffering = false))
    }

    @Test
    fun anOutagePausePendingWaitsWhateverTheNetworkSays() {
        assertTrue(waiting(playWhenReady = false, buffering = false, outagePause = true, validated = true))
        assertTrue(waiting(playWhenReady = false, buffering = false, outagePause = true, validated = false))
    }

    @Test
    fun neverWithAnEmptyListOrWhileItPlays() {
        assertFalse(waiting(count = 0))
        assertFalse(waiting(count = 0, playWhenReady = false, buffering = false, outagePause = true))
        // Play pressed during the wait: the music plays, the wait is over.
        assertFalse(waiting(isPlaying = true, outagePause = true))
        assertFalse(waiting(isPlaying = true, buffering = false))
    }
}
