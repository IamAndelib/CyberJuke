package io.github.iamandelib.cyberjuke.playback

import androidx.media3.common.Player
import androidx.media3.session.CommandButton

/**
 * The notification's and lock screen's Shuffle and Repeat buttons, as pure rules (ModeButtonsTest):
 * each shows the mode as it is, and Repeat steps through the app's own cycle. PlaybackService
 * builds them as Media3 CommandButtons with player commands, which the notification controller
 * may already send (SessionPolicy), so a press goes through the player like the app's own.
 */
internal object ModeButtons {
    /** Repeat's next mode, as the app's button cycles: off, all, one, off. */
    fun nextRepeat(mode: Int): Int = when (mode) {
        Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
        Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
        else -> Player.REPEAT_MODE_OFF
    }

    fun repeatIcon(mode: Int): Int = when (mode) {
        Player.REPEAT_MODE_ALL -> CommandButton.ICON_REPEAT_ALL
        Player.REPEAT_MODE_ONE -> CommandButton.ICON_REPEAT_ONE
        else -> CommandButton.ICON_REPEAT_OFF
    }

    fun repeatLabel(mode: Int): String = when (mode) {
        Player.REPEAT_MODE_ALL -> "Repeat all"
        Player.REPEAT_MODE_ONE -> "Repeat one"
        else -> "Repeat off"
    }

    fun shuffleIcon(on: Boolean): Int = if (on) CommandButton.ICON_SHUFFLE_ON else CommandButton.ICON_SHUFFLE_OFF

    fun shuffleLabel(on: Boolean): String = if (on) "Shuffle on" else "Shuffle off"
}
