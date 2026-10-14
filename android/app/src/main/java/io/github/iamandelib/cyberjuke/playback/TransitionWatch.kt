package io.github.iamandelib.cyberjuke.playback

/**
 * Watches a track's own end for the gap the listener hears. "Gapless" means the app inserts
 * nothing: the next track is buffered while this one plays (LoadAhead) and ExoPlayer moves on to
 * it by itself. What Media3 leaves is the codec's own padding, some 10 to 50 ms: on YouTube's
 * AAC fMP4 the edit list isn't turned into gapless info (FragmentedMp4Extractor, unlike
 * Mp4Extractor), and Opus's tail padding is only trimmed in offload or bypass. No player built on
 * these fixes that, and this app doesn't try; it measures what it can: whether the player had to
 * buffer around the transition, and for how long.
 *
 * Fed the main player's events with the clock passed in (pure, TransitionWatchTest). A track
 * ending by itself ([onAutoTransition]) opens a window of [WINDOW_MS]: buffering within it, or a
 * stall already under way at the transition (the connection ran dry at the end of this one
 * first), makes it [Verdict.Stalled] by the time until READY (or so far, at the deadline); no
 * buffering by the deadline makes it [Verdict.Seamless]. A skip, a seek, a new list or the player
 * stopping ([cancel]) is no transition of a track's own: it ends a watch without a verdict and
 * opens none. The crossfade's hand-over is a seek: never judged.
 */
internal class TransitionWatch {
    sealed interface Verdict {
        /** The music went on without a stall. */
        data object Seamless : Verdict

        /** The music stopped for [gapMs] (at the deadline, still stopped: that long so far). */
        data class Stalled(val gapMs: Long) : Verdict
    }

    /** The transition's time while a watch is open; -1 otherwise. */
    private var since = -1L

    /** When the current stall began; -1 while not stalled. Kept outside a watch: a stall begun before the transition counts. */
    private var stalledAt = -1L

    val watching: Boolean get() = since >= 0L

    /** The player moved on to the next track by itself at [now]; [buffering]: its state then. */
    fun onAutoTransition(now: Long, buffering: Boolean) {
        since = now
        if (!buffering) stalledAt = -1L else if (stalledAt < 0L) stalledAt = now
    }

    /** A skip, a seek, a new list or the player stopping: nothing to judge (any stall is theirs). */
    fun cancel() {
        since = -1L
        stalledAt = -1L
    }

    fun onBuffering(now: Long) {
        if (stalledAt < 0L) stalledAt = now
    }

    /** READY at [now]: the verdict if a transition is being watched. */
    fun onReady(now: Long): Verdict? {
        val v = if (watching) judge(now) else null
        stalledAt = -1L
        return v
    }

    /** The window closed at [now] (post it [WINDOW_MS] after the transition). */
    fun onDeadline(now: Long): Verdict? = if (watching) judge(now) else null

    private fun judge(now: Long): Verdict {
        since = -1L
        return if (stalledAt < 0L) Verdict.Seamless else Verdict.Stalled((now - stalledAt).coerceAtLeast(0L))
    }

    companion object {
        /** Buffering later than this after the transition is the next track's own, not the transition's. */
        const val WINDOW_MS = 1_000L
    }
}
