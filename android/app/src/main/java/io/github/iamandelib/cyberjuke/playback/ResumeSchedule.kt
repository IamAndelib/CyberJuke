package io.github.iamandelib.cyberjuke.playback

import io.github.iamandelib.cyberjuke.net.NetBlock

/**
 * When to try again after an outage pause while the network still looks up. A weak link that
 * stalls a track stays validated, so the network callback's resume never comes; these tries
 * do: [STEPS_MS] after each outage pause, then every [THEN_EVERY_MS], and none after the window
 * ([NetBlock.RESUME_WINDOW_MS] from the streak's first outage pause) is over. The window's end
 * is the last event: the wait ends then, not at the last try.
 *
 * PlaybackService runs it on one Handler.postDelayed on the main looper, at most one pending,
 * only while an outage pause is pending. Pure: the clock is passed in (ResumeScheduleTest).
 */
internal class ResumeSchedule(private val windowMs: Long = NetBlock.RESUME_WINDOW_MS) {
    /** The streak's first outage pause; [IDLE] when no streak runs. */
    private var startedAt = IDLE

    /** The latest outage pause or attempt: the next try is counted from it. */
    private var lastAt = IDLE

    private var attempts = 0

    val active: Boolean get() = startedAt != IDLE

    /**
     * An outage pause at [now]: starts a streak, or goes on with the one running (a try that
     * failed again), whose window still counts from its start.
     */
    fun onOutagePause(now: Long) {
        if (startedAt == IDLE || now - startedAt > windowMs) {
            startedAt = now
            attempts = 0
        }
        lastAt = now
    }

    /**
     * Milliseconds from [now] to the next event: a try, or after the last one the window's end
     * (then [isOver]: the wait is given up, while the network callback could still resume until
     * then). Null: no streak, or it is over.
     */
    fun delayMs(now: Long): Long? {
        if (startedAt == IDLE || isOver(now)) return null
        val due = minOf(lastAt + step(attempts), startedAt + windowMs)
        return (due - now).coerceAtLeast(0L)
    }

    /** The streak's window has run out at [now]. */
    fun isOver(now: Long): Boolean = startedAt != IDLE && now >= startedAt + windowMs

    /** A try ran at [now]. */
    fun attempted(now: Long) {
        if (startedAt == IDLE) return
        attempts++
        lastAt = now
    }

    /** Played again, paused by the user, or given up: the streak is over. */
    fun stop() {
        startedAt = IDLE
        lastAt = IDLE
        attempts = 0
    }

    companion object {
        private const val IDLE = Long.MIN_VALUE

        /** The first tries, each counted from the outage pause (or the try) before it. */
        val STEPS_MS = longArrayOf(15_000L, 30_000L, 60_000L)

        /** Then this often, until the window is over. */
        const val THEN_EVERY_MS = 2L * 60_000L

        fun step(attempt: Int): Long = if (attempt < STEPS_MS.size) STEPS_MS[attempt] else THEN_EVERY_MS
    }
}
