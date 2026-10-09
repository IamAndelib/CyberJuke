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

/**
 * Which features a back-off stops. YouTube judges its player and its music pages separately,
 * so a refused search must not stop the music:
 * - PLAYBACK: resolving streams. A playback block also stops MUSIC (the same IP is flagged).
 * - MUSIC: search, artist pages, playlists, radio and the lyrics' YouTube fallback.
 */
internal enum class Surface { PLAYBACK, MUSIC }

/** Extraction is paused by [NetBlock]; thrown instead of making a request. Never retried. */
internal class BlockedException(
    val until: Long,
    val reason: BlockReason,
    val surface: Surface = Surface.PLAYBACK,
) : IOException("BLOCKED: YouTube back-off until $until ($reason, $surface)")

/**
 * One surface's YouTube back-off (Y1). A bot check or rate limit is a property of our IP, not
 * of the track, so nothing is requested for a while instead of skipping ahead (which would fire
 * more requests from an already flagged IP).
 *
 * Ladder: 1, 3, 10, then 30 minutes. A trip while a back-off is running does not escalate (a
 * prefetch and the playing item failing together count once); the first trip after one has run
 * out does, unless the ladder relaxed meanwhile: one step per [DECAY_MS] since the last back-off
 * ended. [success] (YouTube answered) ends the "unproven" state but keeps the ladder, so a
 * network that is let through once and refused again does not start over at 1 minute.
 * [reset] lifts a running back-off at once (new network, IPv4 setting changed, "Try now").
 *
 * Pure: the clock is passed in, so the state machine is unit-tested (NetBlockTest). Thread-safe.
 */
internal class BlockState {
    data class Snapshot(val until: Long, val reason: BlockReason?, val level: Int)

    private var level = 0          // steps up the ladder; 0 = at the bottom
    private var until = 0L         // the end of the last back-off (in the past once it ran out)
    private var reason: BlockReason? = null
    private var unproven = false   // tripped, and nothing succeeded since

    /** Tests only. */
    @Synchronized
    fun snapshot(): Snapshot = Snapshot(until, reason, level)

    @Synchronized
    fun isBlocked(now: Long): Boolean = now < until

    /** Blocked, or the back-off ran out but nothing has succeeded since (no prefetching then). */
    @Synchronized
    fun isQuiet(now: Long): Boolean = now < until || unproven

    /** The active back-off end (epoch ms) and reason, or (0, null) when not blocked. */
    @Synchronized
    fun active(now: Long): Pair<Long, BlockReason?> = if (now < until) until to reason else 0L to null

    /**
     * Records a block. Returns the new `until` when a back-off started (the caller announces
     * it), or null when one was already running and nothing changed.
     */
    @Synchronized
    fun trip(reason: BlockReason, now: Long): Long? {
        if (now < until) return null
        if (level > 0 && until > 0L) {
            level = maxOf(0, level - ((now - until) / DECAY_MS).toInt())
        }
        val step = LADDER_MIN[minOf(level, LADDER_MIN.size - 1)]
        level = minOf(level + 1, LADDER_MIN.size - 1)
        until = now + step * 60_000L
        this.reason = reason
        unproven = true
        return until
    }

    /** YouTube answered. Returns true if that ends an unproven state (the caller announces it). */
    @Synchronized
    fun success(now: Long): Boolean {
        if (now < until) return false
        if (!unproven) return false
        unproven = false
        return true
    }

    /**
     * Lifts a running back-off now. [keepLevel] false (a new network, so a new IP) also starts
     * the ladder over. Returns true if a back-off was running (the caller announces the end).
     */
    @Synchronized
    fun reset(now: Long, keepLevel: Boolean): Boolean {
        val was = now < until
        if (was) until = now
        if (!keepLevel) level = 0
        return was
    }

    /** Tests only: back to the initial state. */
    @Synchronized
    fun clear() {
        level = 0
        until = 0L
        reason = null
        unproven = false
    }

    companion object {
        val LADDER_MIN = longArrayOf(1, 3, 10, 30)

        /** The ladder relaxes one step per this long without a block. */
        const val DECAY_MS = 30L * 60_000L
    }
}

/**
 * Process-wide back-offs, one per [Surface], plus the playback listeners (the JukePlayer plugin
 * turns them into events, PlaybackService resumes after one).
 */
internal object NetBlock {
    interface Listener {
        fun onBlocked(until: Long, reason: BlockReason)
        fun onUnblocked()

        /** Playback should start once the back-off ends ([wantResume]; any thread). */
        fun onResumeWanted() {}

        /** It no longer should ([cancelResume]; any thread). */
        fun onResumeCancelled() {}
    }

    /** The last limit YouTube put on us, for the Settings diagnostics line. */
    data class LastLimit(val at: Long, val reason: BlockReason, val surface: Surface)

    private val playback = BlockState()
    private val music = BlockState()
    private val listeners = CopyOnWriteArraySet<Listener>()

    @Volatile
    var lastLimit: LastLimit? = null
        private set

    /** Overridable clock for tests. */
    @Volatile
    var clock: () -> Long = { System.currentTimeMillis() }

    /** Until when playback should start again by itself once the back-off ends (0 = don't). */
    @Volatile
    private var resumeUntil = 0L

    /**
     * Auto-resume only within this long of playback being interrupted: no surprise music much
     * later, and inside the 10 minutes Media3 keeps a paused service in the foreground (after
     * that, Android 12+ may refuse to restart playback from the background).
     */
    const val RESUME_WINDOW_MS = 9L * 60_000L

    private fun state(s: Surface) = if (s == Surface.PLAYBACK) playback else music

    fun add(l: Listener) = listeners.add(l)
    fun remove(l: Listener) = listeners.remove(l)

    /** A MUSIC check also sees a playback block (the same IP is flagged). */
    fun isBlocked(surface: Surface = Surface.PLAYBACK): Boolean {
        val now = clock()
        return playback.isBlocked(now) || (surface == Surface.MUSIC && music.isBlocked(now))
    }

    fun isQuiet(): Boolean = playback.isQuiet(clock())

    /** The back-off in force for [surface] (a playback one first), or (0, null). */
    fun active(surface: Surface = Surface.PLAYBACK): Pair<Long, BlockReason?> {
        val now = clock()
        val p = playback.active(now)
        if (p.second != null || surface == Surface.PLAYBACK) return p
        return music.active(now)
    }

    /** Throws [BlockedException] while a back-off for [surface] is running. */
    fun check(surface: Surface = Surface.PLAYBACK) {
        val now = clock()
        playback.active(now).let { (until, reason) ->
            if (reason != null) throw BlockedException(until, reason, Surface.PLAYBACK)
        }
        if (surface == Surface.MUSIC) {
            music.active(now).let { (until, reason) ->
                if (reason != null) throw BlockedException(until, reason, Surface.MUSIC)
            }
        }
    }

    /** See [BlockState.trip]; listeners hear about a new playback back-off only. */
    fun trip(reason: BlockReason, surface: Surface = Surface.PLAYBACK) {
        val now = clock()
        val until = state(surface).trip(reason, now) ?: return
        lastLimit = LastLimit(now, reason, surface)
        if (surface == Surface.PLAYBACK) listeners.forEach { it.onBlocked(until, reason) }
    }

    /**
     * A YouTube request on [surface] succeeded. Ends the unproven state unless a back-off is
     * running (a request that started before the trip proves nothing about now).
     */
    fun requestSucceeded(surface: Surface = Surface.PLAYBACK) {
        if (state(surface).success(clock()) && surface == Surface.PLAYBACK) {
            listeners.forEach { it.onUnblocked() }
        }
    }

    /**
     * Lifts every back-off now: the network or the IPv4 setting changed ([keepLevel] false), or
     * the user asked to try again. Listeners hear the end of a playback back-off.
     */
    fun reset(keepLevel: Boolean) {
        val now = clock()
        music.reset(now, keepLevel)
        if (playback.reset(now, keepLevel)) listeners.forEach { it.onUnblocked() }
    }

    /** Playback was playing (or asked to) when a back-off stopped it: resume once it ends. */
    fun wantResume() {
        resumeUntil = clock() + RESUME_WINDOW_MS
        listeners.forEach { it.onResumeWanted() }
    }

    /** The user paused or stopped: no resume. */
    fun cancelResume() {
        val was = resumeUntil
        resumeUntil = 0L
        if (was > 0L) listeners.forEach { it.onResumeCancelled() }
    }

    /** True once if playback should resume now (and clears it); false if too late or not wanted. */
    fun takeResume(): Boolean {
        val wanted = resumeUntil
        resumeUntil = 0L
        return wanted > 0L && clock() <= wanted
    }

    fun resumePending(): Boolean = resumeUntil > 0L && clock() <= resumeUntil

    /** Tests only. */
    internal fun resetForTest() {
        playback.clear()
        music.clear()
        listeners.clear()
        lastLimit = null
        resumeUntil = 0L
        clock = { System.currentTimeMillis() }
    }
}
