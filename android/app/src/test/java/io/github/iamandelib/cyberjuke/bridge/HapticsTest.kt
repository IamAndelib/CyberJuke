package io.github.iamandelib.cyberjuke.bridge

import androidx.core.view.HapticFeedbackConstantsCompat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HapticsTest {
    @Test
    fun eachKindHasItsFeedback() {
        assertEquals(HapticFeedbackConstantsCompat.LONG_PRESS, Haptics.constantFor("longPress"))
        assertEquals(HapticFeedbackConstantsCompat.CONFIRM, Haptics.constantFor("confirm"))
        assertEquals(HapticFeedbackConstantsCompat.GESTURE_THRESHOLD_ACTIVATE, Haptics.constantFor("threshold"))
    }

    @Test
    fun anUnknownKindHasNone() {
        assertNull(Haptics.constantFor(null))
        assertNull(Haptics.constantFor(""))
        assertNull(Haptics.constantFor("LONG_PRESS"))
        assertNull(Haptics.constantFor("reject"))
    }
}
