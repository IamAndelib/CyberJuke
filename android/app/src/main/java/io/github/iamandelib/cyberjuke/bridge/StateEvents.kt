package io.github.iamandelib.cyberjuke.bridge

import androidx.media3.common.Player

/**
 * Which of the controller's events ([Player.Events]) send the page a new `state`, and what of
 * the player goes in it ([StateEncoder]). Pure (StateEventsTest).
 */
internal object StateEvents {
    /**
     * Whether a batch of [count] events ([at] each one) changes the state: not when it is only
     * the volume, which the page doesn't show and a crossfade steps twenty times over a fade.
     */
    fun changeState(count: Int, at: (Int) -> Int): Boolean =
        (0 until count).any { at(it) != Player.EVENT_VOLUME_CHANGED }

    /**
     * `bufferedAheadMs`: how much of the current track is loaded past [positionMs], from the
     * player's bufferedPosition ([bufferedMs]). 0 when none is, or it isn't known (C.TIME_UNSET
     * is negative; subtracting from it would wrap around). Offline, the page lets an unsaved
     * track resume only with some.
     */
    fun bufferedAheadMs(bufferedMs: Long, positionMs: Long): Long =
        if (bufferedMs <= 0L) 0L else (bufferedMs - positionMs.coerceAtLeast(0L)).coerceAtLeast(0L)
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
