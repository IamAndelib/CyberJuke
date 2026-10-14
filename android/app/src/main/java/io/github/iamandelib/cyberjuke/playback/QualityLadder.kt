package io.github.iamandelib.cyberjuke.playback

/**
 * The Audio quality setting. AUTO steps along the ladder ([QualityGovernor]); HIGH and LOW are
 * always its top and bottom rung.
 */
internal enum class AudioQuality {
    AUTO,
    HIGH,
    LOW,
    ;

    /** The bridge's and the saved value: "auto", "high", "low". */
    val key: String get() = name.lowercase()

    companion object {
        /** Unknown or missing: AUTO, the default. */
        fun of(key: String?): AudioQuality = entries.firstOrNull { it.key == key } ?: AUTO
    }
}

/**
 * A video's audio-only formats as a ladder of rungs, best first (YouTube typically offers
 * about 160, 128, 64 and 48 kbps). The ladder stays within one codec family, so a step changes
 * the bitrate only, never the character of the sound: Opus where its best is about as good as
 * AAC's ([OPUS_AGAINST_AAC]), else AAC.
 * Pure (QualityLadderTest).
 */
internal object QualityLadder {
    enum class Family { OPUS, AAC, OTHER }

    /** The rung that is always the bottom one, whatever the ladder's length. */
    const val LOWEST = Int.MAX_VALUE

    /** Rungs closer than this share of the one above are one rung (the same format twice). */
    const val MIN_STEP = 0.9

    /** Opus is preferred when its best rung is at least this share of AAC's best. */
    const val OPUS_AGAINST_AAC = 0.9

    /** Without a usable Opus: AAC, then anything else. */
    private val PREFERENCE = listOf(Family.AAC, Family.OTHER)

    /** YouTube's Opus comes in WebM, its AAC in MP4. */
    fun familyOf(mimeType: String?): Family = when (mimeType?.substringBefore(';')?.trim()?.lowercase()) {
        "audio/webm", "audio/ogg", "audio/opus" -> Family.OPUS
        "audio/mp4", "audio/m4a", "audio/aac" -> Family.AAC
        else -> Family.OTHER
    }

    /**
     * [formats] as a ladder: the preferred family that has a known bitrate, highest bitrate
     * first, one format per rung. Formats of unknown bitrate (<= 0) only make a ladder (of
     * their given order) when no format of any family has one.
     */
    fun <T> rank(formats: List<T>, bitrate: (T) -> Int, mimeType: (T) -> String?): List<T> {
        if (formats.isEmpty()) return emptyList()
        val byFamily = formats.groupBy { familyOf(mimeType(it)) }
        /** The family's best known bitrate, 0 when it has none. */
        fun top(f: Family): Int = byFamily[f]?.maxOfOrNull { bitrate(it) }?.coerceAtLeast(0) ?: 0
        // Opus only when its best is about as good as AAC's (a video may offer only a low Opus).
        val family = when {
            top(Family.OPUS) > 0 && top(Family.OPUS) >= top(Family.AAC) * OPUS_AGAINST_AAC -> Family.OPUS
            else -> PREFERENCE.firstOrNull { top(it) > 0 } ?: return formats
        }
        val known = byFamily.getValue(family).filter { bitrate(it) > 0 }.sortedByDescending(bitrate)
        val rungs = ArrayList<T>(known.size)
        for (f in known) {
            if (rungs.isEmpty() || bitrate(f) < bitrate(rungs.last()) * MIN_STEP) rungs.add(f)
        }
        return rungs
    }

    /** The index [rung] (counted from the top, [LOWEST] for the bottom) plays in a ladder of [size]. */
    fun index(size: Int, rung: Int): Int = rung.coerceIn(0, (size - 1).coerceAtLeast(0))

    /** The rung a setting asks for; [autoRung] is the governor's, for AUTO. */
    fun rungFor(quality: AudioQuality, autoRung: Int): Int = when (quality) {
        AudioQuality.HIGH -> 0
        AudioQuality.LOW -> LOWEST
        AudioQuality.AUTO -> autoRung.coerceAtLeast(0)
    }
}
