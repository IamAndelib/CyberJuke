package io.github.iamandelib.cyberjuke.playback

import org.junit.Assert.assertEquals
import org.junit.Test

class QualityLadderTest {
    private data class F(val itag: Int, val bitrate: Int, val mime: String?)

    private fun rank(vararg f: F) = QualityLadder.rank(f.toList(), { it.bitrate }, { it.mime }).map { it.itag }

    // What YouTube typically offers for a music video (bps).
    private val opus160 = F(251, 160_000, "audio/webm")
    private val opus70 = F(250, 70_000, "audio/webm")
    private val opus50 = F(249, 50_000, "audio/webm")
    private val aac128 = F(140, 128_000, "audio/mp4")
    private val aac48 = F(139, 48_000, "audio/mp4")

    @Test
    fun oneCodecFamilyBestFirstOpusPreferred() {
        assertEquals(listOf(251, 250, 249), rank(aac128, opus50, opus160, aac48, opus70))
        // No Opus offered: AAC.
        assertEquals(listOf(140, 139), rank(aac48, aac128))
        // Neither: whatever there is, by bitrate.
        assertEquals(listOf(2, 1), rank(F(1, 64_000, "audio/mpeg"), F(2, 96_000, null)))
    }

    @Test
    fun aLowOpusLosesToABetterAac() {
        // Only a 70 kbps Opus next to a 128 kbps AAC: High must not pick the 70.
        assertEquals(listOf(140, 139), rank(opus70, opus50, aac128, aac48))
        // Opus about as good as AAC (at least 90 %) still wins.
        assertEquals(listOf(9, 250), rank(F(9, 120_000, "audio/webm"), opus70, aac128, aac48))
        assertEquals(listOf(140), rank(F(9, 110_000, "audio/webm"), aac128))
    }

    @Test
    fun familiesComeFromTheMimeType() {
        assertEquals(QualityLadder.Family.OPUS, QualityLadder.familyOf("audio/webm; codecs=\"opus\""))
        assertEquals(QualityLadder.Family.OPUS, QualityLadder.familyOf("AUDIO/WEBM"))
        assertEquals(QualityLadder.Family.AAC, QualityLadder.familyOf("audio/mp4"))
        assertEquals(QualityLadder.Family.OTHER, QualityLadder.familyOf(null))
        assertEquals(QualityLadder.Family.OTHER, QualityLadder.familyOf("video/mp4"))
    }

    @Test
    fun unknownBitratesStayOffTheLadder() {
        assertEquals(listOf(251, 249), rank(F(9, -1, "audio/webm"), opus160, opus50))
        // An Opus family with no known bitrate loses to AAC with one.
        assertEquals(listOf(140), rank(F(9, -1, "audio/webm"), aac128))
        // Nothing known anywhere: the formats as given.
        assertEquals(listOf(9, 8), rank(F(9, -1, "audio/webm"), F(8, 0, "audio/mp4")))
        assertEquals(emptyList<Int>(), rank())
    }

    @Test
    fun theSameFormatTwiceIsOneRung() {
        // A DRC copy of 251 at nearly the same bitrate: not a step anyone would hear.
        assertEquals(listOf(251, 250), rank(opus160, F(2510, 155_000, "audio/webm"), opus70))
    }

    @Test
    fun highIsTheTopLowTheBottomAutoItsRung() {
        assertEquals(0, QualityLadder.rungFor(AudioQuality.HIGH, 2))
        assertEquals(QualityLadder.LOWEST, QualityLadder.rungFor(AudioQuality.LOW, 0))
        assertEquals(2, QualityLadder.rungFor(AudioQuality.AUTO, 2))
        // Clamped to the ladder at hand.
        assertEquals(0, QualityLadder.index(3, 0))
        assertEquals(2, QualityLadder.index(3, QualityLadder.LOWEST))
        assertEquals(1, QualityLadder.index(2, 5))
        assertEquals(0, QualityLadder.index(1, QualityLadder.LOWEST))
        assertEquals(0, QualityLadder.index(0, 3))
    }

    @Test
    fun theSettingFallsBackToAuto() {
        assertEquals(AudioQuality.AUTO, AudioQuality.of("auto"))
        assertEquals(AudioQuality.HIGH, AudioQuality.of("high"))
        assertEquals(AudioQuality.LOW, AudioQuality.of("low"))
        assertEquals(AudioQuality.AUTO, AudioQuality.of(null))
        assertEquals(AudioQuality.AUTO, AudioQuality.of("ultra"))
        assertEquals(listOf("auto", "high", "low"), AudioQuality.entries.map { it.key })
    }
}
