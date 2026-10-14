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
