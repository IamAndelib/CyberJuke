package io.github.iamandelib.cyberjuke.lyrics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LrcTest {

    @Test
    fun parsesFormatsAndSorts() {
        val lrc = """
            [ar:Queen]
            [ti:Bohemian Rhapsody]
            [00:01.5]tenths
            [00:02.25]hundredths
            [00:03.125]millis
            [00:04]no fraction
            [00:05:50]colon fraction
            [01:00.00][00:10.00]Chorus
        """.trimIndent()
        val lines = Lrc.parse(lrc)
        assertEquals(
            listOf(
                Lrc.Line(1500, "tenths"),
                Lrc.Line(2250, "hundredths"),
                Lrc.Line(3125, "millis"),
                Lrc.Line(4000, "no fraction"),
                Lrc.Line(5500, "colon fraction"),
                Lrc.Line(10_000, "Chorus"),
                Lrc.Line(60_000, "Chorus"),
            ),
            lines,
        )
    }

    @Test
    fun offsetBlankLinesAndExtras() {
        val lrc = "[offset:+500]\n[00:01.00]a\n[00:00.20]\n\nplain text\n[00:03.00][Chorus] <00:03.10>la <00:03.50>la\n﻿[00:04.00]  Ελληνικά  "
        val lines = Lrc.parse(lrc)
        assertEquals(
            listOf(
                Lrc.Line(0, ""), // 200 - 500 clamped
                Lrc.Line(500, "a"),
                Lrc.Line(2500, "[Chorus] la la"),
                Lrc.Line(3500, "Ελληνικά"),
            ),
            lines,
        )
        assertEquals(listOf(Lrc.Line(1250, "x")), Lrc.parse("[offset:-250]\n[00:01.00]x"))
        assertTrue(Lrc.parse(null).isEmpty())
        assertTrue(Lrc.parse("[ar:x]\nno times").isEmpty())
    }

    private fun e(artist: String, d: Double?, synced: String? = null, plain: String? = null, instr: Boolean = false) =
        Lrc.LrclibEntry("Song", artist, d, instr, plain, synced)

    @Test
    fun pickBestFiltersAndPrefersSynced() {
        val plainClose = e("Queen", 354.0, plain = "p")
        val syncedFar = e("Queen", 356.5, synced = "[00:01.00]s")
        val tooFar = e("Queen", 360.0, synced = "[00:01.00]s")
        val wrongArtist = e("Ivy Queen", 354.0, synced = "[00:01.00]s")
        val empty = e("Queen", 354.0)
        val all = listOf(empty, wrongArtist, tooFar, plainClose, syncedFar)
        assertEquals(syncedFar, Lrc.pickBest(all, "Queen", 354.0))
        assertEquals(plainClose, Lrc.pickBest(listOf(plainClose, tooFar), "Queen", 354.0))
        assertNull(Lrc.pickBest(listOf(wrongArtist, empty), "Queen", 354.0))
        // no duration: any duration (even unknown) is fine
        assertEquals(tooFar, Lrc.pickBest(listOf(e("Queen", null, plain = "p"), tooFar), "Queen", null))
        // lyrics beat an instrumental flag
        val instr = e("Queen", 354.0, instr = true)
        assertEquals(plainClose, Lrc.pickBest(listOf(instr, plainClose), "Queen", 354.0))
        assertEquals(instr, Lrc.pickBest(listOf(instr), "Queen", 354.0))
    }
}
