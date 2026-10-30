package io.github.iamandelib.cyberjuke.playback

import androidx.media3.common.Player
import androidx.media3.session.CommandButton
import org.junit.Assert.assertEquals
import org.junit.Test

class ModeButtonsTest {
    @Test
    fun repeatStepsThroughTheAppsCycleAndShowsTheModeItIsIn() {
        // Off, all, one, off: as Now Playing's button.
        assertEquals(Player.REPEAT_MODE_ALL, ModeButtons.nextRepeat(Player.REPEAT_MODE_OFF))
        assertEquals(Player.REPEAT_MODE_ONE, ModeButtons.nextRepeat(Player.REPEAT_MODE_ALL))
        assertEquals(Player.REPEAT_MODE_OFF, ModeButtons.nextRepeat(Player.REPEAT_MODE_ONE))
        assertEquals(CommandButton.ICON_REPEAT_OFF, ModeButtons.repeatIcon(Player.REPEAT_MODE_OFF))
        assertEquals(CommandButton.ICON_REPEAT_ALL, ModeButtons.repeatIcon(Player.REPEAT_MODE_ALL))
        assertEquals(CommandButton.ICON_REPEAT_ONE, ModeButtons.repeatIcon(Player.REPEAT_MODE_ONE))
        assertEquals("Repeat one", ModeButtons.repeatLabel(Player.REPEAT_MODE_ONE))
    }

    @Test
    fun shuffleShowsWhetherItIsOn() {
        assertEquals(CommandButton.ICON_SHUFFLE_ON, ModeButtons.shuffleIcon(true))
        assertEquals(CommandButton.ICON_SHUFFLE_OFF, ModeButtons.shuffleIcon(false))
        assertEquals("Shuffle off", ModeButtons.shuffleLabel(false))
    }
}
