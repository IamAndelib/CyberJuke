package io.github.iamandelib.cyberjuke.playback

/**
 * How far ahead the player buffers (PlaybackService's DefaultLoadControl). Audio is about 1 MB
 * a minute, so most of a track is buffered early and a short drop is never heard. Pure
 * (LoadPolicyTest checks what DefaultLoadControl.Builder would refuse at service start).
 */
internal object BufferPolicy {
    /** Keep loading until this much is buffered (Media3's default is 50 s). */
    const val MIN_MS = 120_000

    /** Never more than this. */
    const val MAX_MS = 600_000

    /** Start playing once this much is there. */
    const val START_MS = 2_500

    /** After a stall, wait for a little more, so it doesn't stall again at once. */
    const val AFTER_REBUFFER_MS = 5_000

    /** Kept behind the position, so seeking back a little costs nothing. */
    const val BACK_MS = 30_000

    /**
     * The memory cap: 10 minutes at 160 kbps (an audio-only stream never reaches it). Below
     * [MIN_MS] loading goes on regardless (time wins over size); past it this is the limit,
     * which only a video fallback stream would hit.
     */
    const val TARGET_BYTES = 16 * 1024 * 1024
}

/**
 * Retries of a failed load (JukeLoadErrorPolicy): a network error is tried again [NETWORK_RETRIES]
 * times, with a capped back-off, before it reaches the player, while the buffer covers the gap.
 * Pure (LoadPolicyTest).
 */
internal object LoadRetry {
    const val NETWORK_RETRIES = 6

    const val MAX_DELAY_MS = 8_000L

    /** 1 s, 2 s, 4 s, then [MAX_DELAY_MS], for the [errorCount]th error in a row (from 1). */
    fun delayMs(errorCount: Int): Long = (1_000L shl (errorCount - 1).coerceIn(0, 4)).coerceAtMost(MAX_DELAY_MS)
}
