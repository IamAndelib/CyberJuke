package io.github.iamandelib.cyberjuke

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThemeWindowTest {
    @Test
    fun themeBackgroundsParseAsOpaqueColours() {
        assertEquals(0xFF000000.toInt(), ThemeWindow.parse("#000"))
        assertEquals(0xFFEFE5C0.toInt(), ThemeWindow.parse("#efe5c0"))
        assertEquals(0xFF2A2AB8.toInt(), ThemeWindow.parse("#2A2AB8"))
        assertEquals(0xFFFFE4F1.toInt(), ThemeWindow.parse("#ffe4f1"))
        assertEquals(0xFF112233.toInt(), ThemeWindow.parse("#123"))
        assertEquals(ThemeWindow.DEFAULT_BACKGROUND, ThemeWindow.parse("#000000"))
    }

    @Test
    fun anythingElseIsRefused() {
        for (bad in listOf(null, "", "#", "000", "#00", "#0000", "#00000000", "#ggg", "#12345z", "rgb(0,0,0)", "#１２３", " #000", "#000 ")) {
            assertNull("$bad", ThemeWindow.parse(bad))
        }
    }

    @Test
    fun theSplashWaitsForTheFirstScreenButNotForever() {
        assertTrue(ThemeWindow.keepSplash(0, firstScreenShown = false))
        assertTrue(ThemeWindow.keepSplash(ThemeWindow.SPLASH_MAX_MS - 1, firstScreenShown = false))
        assertFalse(ThemeWindow.keepSplash(ThemeWindow.SPLASH_MAX_MS, firstScreenShown = false))
        assertFalse(ThemeWindow.keepSplash(0, firstScreenShown = true))
        assertFalse(ThemeWindow.keepSplash(10_000, firstScreenShown = true))
    }
}
