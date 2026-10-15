package io.github.iamandelib.cyberjuke.bridge

import androidx.media3.common.Player

/** Which of the controller's events ([Player.Events]) send the page a new `state`. Pure (StateEventsTest). */
internal object StateEvents {
    /**
     * Whether a batch of [count] events ([at] each one) changes the state: not when it is only
     * the volume, which the page doesn't show and a crossfade steps every 50 ms.
     */
    fun changeState(count: Int, at: (Int) -> Int): Boolean =
        (0 until count).any { at(it) != Player.EVENT_VOLUME_CHANGED }
}

/**
 * When the `state` event says the music waits for the carrier (`waitingForNetwork`): the list
 * isn't empty, nothing plays, and either an outage pause is pending (NetBlock: it resumes by
 * itself once the network is back) or play is wanted, the player is buffering and the device
 * has no validated network. The second half says so as soon as the music stalls, not only once
 * Media3's retries have run out (TrackErrorPolicy, which can take a minute or two). Pure
 * (StateEventsTest).
 */
internal object WaitingRule {
    fun waiting(
        count: Int,
        isPlaying: Boolean,
        playWhenReady: Boolean,
        buffering: Boolean,
        outagePause: Boolean,
        validated: Boolean,
    ): Boolean = count > 0 && !isPlaying && (outagePause || (playWhenReady && buffering && !validated))
}
