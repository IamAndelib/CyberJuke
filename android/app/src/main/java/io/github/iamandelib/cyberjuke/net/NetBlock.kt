package io.github.iamandelib.cyberjuke.net

import java.io.IOException
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Why YouTube is refusing us. The names are the `reason` of the JukePlayer `blocked` event.
 * - BOT_CHECK: "Sign in to confirm you're not a bot" (or a reCAPTCHA page).
 * - RATE_LIMIT: HTTP 429 (or "content isn't available, try again later").
 * - STREAM_FORBIDDEN: HTTP 403 on a stream URL we had only just resolved.
 */
internal enum class BlockReason { BOT_CHECK, RATE_LIMIT, STREAM_FORBIDDEN }

/** Extraction is paused by [NetBlock]; thrown instead of making a request. Never retried. */
internal class BlockedException(val until: Long, val reason: BlockReason) :
    IOException("BLOCKED: YouTube back-off until $until ($reason)")

/**
 * Network-wide YouTube back-off (Y1). A bot check or rate limit is a property of our IP, not of
 * the track, so the player stops making requests for a while instead of skipping ahead (which
 * would fire more requests from an already flagged IP).
 *
 * Ladder: 2, 5, 15, then 60 minutes. A trip while a back-off is running does not escalate (a
 * prefetch and the playing item failing together count once); the first trip after a back-off
 * has run out does. [success] resets the ladder; it is called when YouTube actually answered
 * (an extraction or an InnerTube request, [requestSucceeded]), never for playback from a
 * cached URL or buffered bytes, which proves nothing.
 *
 * Pure apart from its listeners: the clock is passed in, so the state machine is unit-tested
 * (NetBlockTest). Thread-safe.
 */
internal class BlockState {
    data class Snapshot(val until: Long, val reason: BlockReason?, val level: Int)

    private var level = 0          // trips since the last success; 0 = never blocked
    private var until = 0L
    private var reason: BlockReason? = null

    @Synchronized
    fun snapshot(): Snapshot = Snapshot(until, reason, level)

    @Synchronized
    fun isBlocked(now: Long): Boolean = now < until

    /** Blocked, or the back-off ran out but nothing has succeeded since (no prefetching then). */
    @Synchronized
    fun isQuiet(now: Long): Boolean = now < until || level > 0

    /** The active back-off end (epoch ms) and reason, or (0, null) when not blocked. */
    @Synchronized
    fun active(now: Long): Pair<Long, BlockReason?> = if (now < until) until to reason else 0L to null

    /**
     * Records a block. Returns the new `until` when the back-off started or was extended (the
     * caller announces it), or null when one was already running and nothing changed.
     */
    @Synchronized
    fun trip(reason: BlockReason, now: Long): Long? {
        if (now < until) return null
        val step = LADDER_MIN[minOf(level, LADDER_MIN.size - 1)]
        level++
        until = now + step * 60_000L
        this.reason = reason
        return until
    }

    /** Playback works again. Returns true if a block was recorded (the caller announces it). */
    @Synchronized
    fun success(): Boolean {
        if (level == 0 && until == 0L) return false
        level = 0
        until = 0L
        reason = null
        return true
    }

    companion object {
        val LADDER_MIN = longArrayOf(2, 5, 15, 60)
    }
}

/** Process-wide [BlockState] plus listeners (the JukePlayer plugin turns them into events). */
internal object NetBlock {
    interface Listener {
        fun onBlocked(until: Long, reason: BlockReason)
        fun onUnblocked()
    }

    private val state = BlockState()
    private val listeners = CopyOnWriteArraySet<Listener>()

    /** Overridable clock for tests. */
    @Volatile
    var clock: () -> Long = { System.currentTimeMillis() }

    fun add(l: Listener) = listeners.add(l)
    fun remove(l: Listener) = listeners.remove(l)

    fun isBlocked(): Boolean = state.isBlocked(clock())
    fun isQuiet(): Boolean = state.isQuiet(clock())
    fun active(): Pair<Long, BlockReason?> = state.active(clock())

    /** Throws [BlockedException] while a back-off is running. */
    fun check() {
        val (until, reason) = active()
        if (reason != null) throw BlockedException(until, reason)
    }

    /** See [BlockState.trip]; listeners hear about a new or extended back-off only. */
    fun trip(reason: BlockReason) {
        val until = state.trip(reason, clock()) ?: return
        listeners.forEach { it.onBlocked(until, reason) }
    }

    fun success() {
        if (state.success()) listeners.forEach { it.onUnblocked() }
    }

    /**
     * A YouTube request succeeded: [success], unless a back-off is running (a request that
     * started before the trip proves nothing about now).
     */
    fun requestSucceeded() {
        if (!isBlocked()) success()
    }

    /** Tests only. */
    internal fun resetForTest() {
        state.success()
        listeners.clear()
        clock = { System.currentTimeMillis() }
    }
}
