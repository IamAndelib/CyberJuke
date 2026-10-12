package io.github.iamandelib.cyberjuke.playback

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * Crossfade (Settings → Crossfade): when a track ends by itself, its last seconds fade out
 * while the next one fades in. Media3 has no crossfade of its own (as of 1.11), so the queue,
 * the session and the notification stay on the one ExoPlayer, which moves on to the next track
 * a fade early, and a second, bare player ([Crossfader.Tail]) plays the end of the outgoing
 * track over it. Pure (CrossfadeTest): what to fade, from where and how long, and the curve.
 */
internal object CrossfadePlan {
    /** The setting's choices: Off, 3 s, 6 s and 10 s. */
    val CHOICES_MS = listOf(0, 3_000, 6_000, 10_000)

    /** A shorter fade isn't worth one (a fade shrunk to fit a short track). */
    const val MIN_FADE_MS = 1_000L

    /** The tail plays this long, muted, before the hand-over, so its sound is already flowing then. */
    const val PREROLL_MS = 300L

    /** Time the tail gets to load before its preroll (from the listening cache it needs far less). */
    const val PREP_MS = 1_500L

    /** Less time than this to load and the track ends the usual way. */
    const val MIN_PREP_MS = 500L

    /** The volume steps, only while a fade runs. */
    const val STEP_MS = 50L

    /** The next track starts this much into its buffer ([BufferPolicy.START_MS]); a fade needs it ready. */
    private const val START_MS = BufferPolicy.START_MS.toLong()

    /** Buffered to within this of the end counts as all there. */
    private const val SLACK_MS = 1_000L

    /** [ms] if it's one of [CHOICES_MS], else null. */
    fun valid(ms: Int?): Int? = ms?.takeIf { it in CHOICES_MS }

    /**
     * The fade between a track of [durationMs] and one of [nextDurationMs] (<= 0: not known yet)
     * with the setting at [settingMs]: shrunk to a third of the shorter of the two, and 0 (none)
     * below [MIN_FADE_MS] or when the setting is Off.
     */
    fun fadeMs(settingMs: Long, durationMs: Long, nextDurationMs: Long): Long {
        if (settingMs <= 0L || durationMs <= 0L) return 0L
        var f = minOf(settingMs, durationMs / 3)
        if (nextDurationMs > 0L) f = minOf(f, nextDurationMs / 3)
        return if (f < MIN_FADE_MS) 0L else f
    }

    /**
     * Where the playing track's tail is made ready (its "prime"), from the setting and the
     * track's own length (the next track may shrink the fade later, never lengthen it); null
     * when there is no fade.
     */
    fun primeAtMs(settingMs: Long, durationMs: Long): Long? {
        val f = fadeMs(settingMs, durationMs, -1L)
        if (f == 0L) return null
        return (durationMs - f - PREROLL_MS - PREP_MS).coerceAtLeast(0L)
    }

    /** What the next track must have buffered for a fade of [fadeMs]: its start and the fade, or all of it. */
    fun nextNeededMs(fadeMs: Long, nextDurationMs: Long): Long =
        minOf(fadeMs + START_MS, (nextDurationMs - SLACK_MS).coerceAtLeast(0L))

    /** The main player, as the crossfade sees it. */
    data class Facts(
        val settingMs: Long,
        /** Playing now: play wanted, READY, nothing (a call, say) holding it back. */
        val playing: Boolean,
        val repeatOne: Boolean,
        val hasNext: Boolean,
        /** Waiting for the network, or a back-off. */
        val outage: Boolean,
        /** Our own `cyberjuke://` item (not an HLS fallback), so the tail can open the same stream. */
        val ours: Boolean,
        val durationMs: Long,
        val positionMs: Long,
        /** <= 0 while unknown (the next track isn't prepared). */
        val nextDurationMs: Long,
        /** How much of the next track is buffered. */
        val nextBufferedMs: Long,
    )

    enum class Skip { OFF, NOT_PLAYING, REPEAT_ONE, LAST, OUTAGE, NOT_OURS, TOO_SHORT, TOO_LATE, NEXT_NOT_READY }

    sealed interface Decision {
        /** Fade for [fadeMs], handing over at [startAtMs] of the playing track. */
        data class Fade(val fadeMs: Long, val startAtMs: Long) : Decision

        /** The track ends the usual way. */
        data class No(val why: Skip) : Decision
    }

    /**
     * At the prime: fade or not. Not on repeat-one, the last track, during an outage or a
     * back-off, on a fallback stream, with too little time left to load the tail (a seek near
     * the end), or when the next track couldn't start at once (a normal transition then, never
     * a stall).
     */
    fun decide(f: Facts): Decision {
        if (f.settingMs <= 0L) return Decision.No(Skip.OFF)
        if (!f.playing) return Decision.No(Skip.NOT_PLAYING)
        if (f.repeatOne) return Decision.No(Skip.REPEAT_ONE)
        if (!f.hasNext) return Decision.No(Skip.LAST)
        if (f.outage) return Decision.No(Skip.OUTAGE)
        if (!f.ours) return Decision.No(Skip.NOT_OURS)
        val fade = fadeMs(f.settingMs, f.durationMs, f.nextDurationMs)
        if (fade == 0L) return Decision.No(Skip.TOO_SHORT)
        val startAt = f.durationMs - fade
        if (f.positionMs > startAt - PREROLL_MS - MIN_PREP_MS) return Decision.No(Skip.TOO_LATE)
        if (!nextReady(f, fade)) return Decision.No(Skip.NEXT_NOT_READY)
        return Decision.Fade(fade, startAt)
    }

    /** At the hand-over: still playing, still a next track, no outage, and it is buffered. */
    fun canHandOver(f: Facts, fadeMs: Long): Boolean =
        f.playing && f.hasNext && !f.repeatOne && !f.outage && nextReady(f, fadeMs)

    private fun nextReady(f: Facts, fadeMs: Long): Boolean =
        f.nextDurationMs > 0L && f.nextBufferedMs >= nextNeededMs(fadeMs, f.nextDurationMs)

    /** How far into a fade of [fadeMs] started at [startedAt] it is at [now], 0..1. */
    fun progress(now: Long, startedAt: Long, fadeMs: Long): Float =
        if (fadeMs <= 0L) 1f else ((now - startedAt).toFloat() / fadeMs).coerceIn(0f, 1f)

    /** Equal power: the outgoing track's gain at [t] (1 → 0); the two add up to constant loudness. */
    fun outGain(t: Float): Float = cos(t.coerceIn(0f, 1f) * PI / 2).toFloat().coerceIn(0f, 1f)

    /** The incoming track's gain at [t] (0 → 1). */
    fun inGain(t: Float): Float = sin(t.coerceIn(0f, 1f) * PI / 2).toFloat().coerceIn(0f, 1f)
}

/**
 * Runs the crossfade over the main player ([Host]) and a tail player ([Tail]), on the main
 * thread. Pure (CrossfadeTest, with fakes); the Android side is ExoCrossfadeHost.
 *
 * For each track, a position message ([Host.at], no timer) at [CrossfadePlan.primeAtMs]:
 * - prime: [CrossfadePlan.decide]; on a fade, the tail is made (paused, at the hand-over minus
 *   [CrossfadePlan.PREROLL_MS]) and two more position messages are set;
 * - preroll: the tail plays, muted (not ready by then: no fade, the tail goes);
 * - hand-over: the tail takes the outgoing track's volume, the main player goes silent and moves
 *   on to the next track ([Host.advance]); then volume steps every [CrossfadePlan.STEP_MS]
 *   (the only timer, only during a fade) until the fade ends and the tail is released.
 *
 * A pause, seek, skip, stop, a new current track, a call or other loss of audio focus, a stall
 * of the outgoing track or a tail error stops it at once: the tail goes, its step is removed and
 * the main player's volume is whole again ([stop]). An edit of the queue or the repeat or shuffle
 * mode before the hand-over plans again (the next track may have changed); after it, the fade
 * goes on (it no longer depends on the queue).
 */
internal class Crossfader(private val host: Host, settingMs: Int) {
    interface Host {
        /** The main player's facts for the plan. */
        fun facts(settingMs: Long): CrossfadePlan.Facts

        /** Identifies the main player's current item (stable across edits of the list); null when empty. */
        fun currentItem(): Any?

        fun positionMs(): Long

        /** The current track's length; <= 0 while unknown. */
        fun durationMs(): Long

        /** Runs [action] on the main thread when the current item plays through [positionMs]. */
        fun at(positionMs: Long, action: () -> Unit)

        /** Cancels everything [at] set. */
        fun cancelAll()

        fun post(delayMs: Long, r: Runnable)

        fun remove(r: Runnable)

        fun now(): Long

        /** The main player's own volume (its setting, 1 unless something changed it). */
        val baseVolume: Float

        /** The main player's output volume, as a fade sets it (not its volume setting: no events). */
        fun setMainVolume(v: Float)

        /** The main player moves on to its next track. */
        fun advance()

        /** A paused tail of the current track at [positionMs], loading; null when it can't be made. */
        fun newTail(positionMs: Long, events: TailEvents): Tail?
    }

    interface Tail {
        val isReady: Boolean

        fun play()

        fun setVolume(v: Float)

        fun release()
    }

    interface TailEvents {
        fun onTailEnded()

        fun onTailError()
    }

    enum class Phase { NONE, PRIMED, PREROLL, FADING }

    var phase = Phase.NONE
        private set

    private var settingMs = (CrossfadePlan.valid(settingMs) ?: 0).toLong()

    /** Bumped by every new plan: a message of an older one does nothing. */
    private var generation = 0

    /** The item the messages were set for. */
    private var item: Any? = null

    private var tail: Tail? = null
    private var fadeMs = 0L
    private var startedAt = 0L
    private var base = 1f

    /** Inside our own [Host.advance]: its events are ours, not the user's. */
    private var advancing = false

    private val stepTask = Runnable { step() }

    /** Counts tails, so a released one's late event changes nothing. */
    private var tailNumber = 0

    private fun eventsOf(n: Int) = object : TailEvents {
        override fun onTailEnded() = ended(n)

        override fun onTailError() = ended(n)
    }

    /** The tail ended (its track did, at the fade's end) or failed: the fade is over. */
    private fun ended(n: Int) {
        if (n == tailNumber && tail != null) stop()
    }

    /** The setting (anything but [CrossfadePlan.CHOICES_MS] is Off). Changed, a fade under way stops. */
    fun setSetting(ms: Int) {
        val v = (CrossfadePlan.valid(ms) ?: 0).toLong()
        if (v == settingMs) return
        settingMs = v
        stop()
        arm()
    }

    // ---- the main player's events --------------------------------------------------------

    /** A new current item that isn't our hand-over's (a skip, a removal, a new list, an error's skip). */
    fun onItemChanged() {
        if (advancing) return
        stop()
        arm()
    }

    /**
     * A seek. [nearStart]: to within a second of the item's start; that soon after our own
     * hand-over it is its late echo, not the user's.
     */
    fun onSeek(nearStart: Boolean) {
        if (advancing) return
        if (phase == Phase.FADING && nearStart && host.now() - startedAt < ECHO_MS) return
        stop()
        arm()
    }

    /** Paused, stopped, ended, or held back (a call, another app's audio). */
    fun onHalted() {
        if (advancing) return
        stop()
    }

    /** Playing again (or allowed to): the current track gets its messages again. */
    fun onResumed() {
        if (advancing) return
        if (phase == Phase.NONE) arm()
    }

    /** The outgoing track stalls before the hand-over: the tail would drift from it. */
    fun onBuffering() {
        if (advancing) return
        if (phase == Phase.PRIMED || phase == Phase.PREROLL) stop()
    }

    /** READY: the length may be known now. */
    fun onReady() {
        if (advancing) return
        if (phase == Phase.NONE) arm()
    }

    /** The list, repeat or shuffle changed: before the hand-over the next track may differ, so plan again. */
    fun onQueueChanged() {
        if (advancing) return
        if (phase == Phase.PRIMED || phase == Phase.PREROLL) stop()
        arm()
    }

    /** A track's length became known. */
    fun onDurationKnown() {
        if (advancing) return
        if (phase == Phase.NONE || phase == Phase.FADING) arm()
    }

    /** The service ends: nothing may outlive it. */
    fun release() {
        stop()
        host.cancelAll()
        generation++
    }

    // ---- the plan ------------------------------------------------------------------------

    /**
     * Sets the current track's prime (a fade already running goes on: these messages are for
     * the track after it). Never while a tail is primed (callers stop it first).
     */
    private fun arm() {
        host.cancelAll()
        val g = ++generation
        item = null
        if (settingMs <= 0L) return
        val primeAt = CrossfadePlan.primeAtMs(settingMs, host.durationMs()) ?: return
        item = host.currentItem() ?: return
        // Already past it (a resume or a seek near the end): prime now; decide() turns down what's too late.
        if (host.positionMs() >= primeAt) prime(g) else host.at(primeAt) { prime(g) }
    }

    private fun current(g: Int) = g == generation && host.currentItem() == item

    private fun prime(g: Int) {
        if (!current(g) || phase != Phase.NONE) return
        val d = CrossfadePlan.decide(host.facts(settingMs))
        if (d !is CrossfadePlan.Decision.Fade) return
        val t = host.newTail(d.startAtMs - CrossfadePlan.PREROLL_MS, eventsOf(++tailNumber)) ?: return
        tail = t
        fadeMs = d.fadeMs
        phase = Phase.PRIMED
        host.at(d.startAtMs - CrossfadePlan.PREROLL_MS) { preroll(g) }
        host.at(d.startAtMs) { handOver(g) }
    }

    private fun preroll(g: Int) {
        if (!current(g) || phase != Phase.PRIMED) return
        val t = tail ?: return
        if (!t.isReady) {
            stop()
            return
        }
        t.setVolume(0f)
        t.play()
        phase = Phase.PREROLL
    }

    private fun handOver(g: Int) {
        if (!current(g) || phase != Phase.PREROLL) {
            if (phase == Phase.PRIMED) stop()
            return
        }
        val t = tail ?: return
        if (!CrossfadePlan.canHandOver(host.facts(settingMs), fadeMs)) {
            stop()
            return
        }
        base = host.baseVolume
        t.setVolume(base)
        host.setMainVolume(0f)
        phase = Phase.FADING
        startedAt = host.now()
        advancing = true
        try {
            host.advance()
        } catch (e: RuntimeException) {
            // Never left silent.
            stop()
            return
        } finally {
            advancing = false
        }
        host.post(CrossfadePlan.STEP_MS, stepTask)
        // The next track's own prime, for the fade after this one.
        arm()
    }

    private fun step() {
        if (phase != Phase.FADING) return
        val t = CrossfadePlan.progress(host.now(), startedAt, fadeMs)
        if (t >= 1f) {
            stop()
            return
        }
        tail?.setVolume(base * CrossfadePlan.outGain(t))
        host.setMainVolume(base * CrossfadePlan.inGain(t))
        host.post(CrossfadePlan.STEP_MS, stepTask)
    }

    /** Ends any fade at once: the tail goes, its step too, and the main player is at full volume. */
    private fun stop() {
        host.remove(stepTask)
        val t = tail
        tail = null
        val wasFading = phase == Phase.FADING
        phase = Phase.NONE
        t?.release()
        if (wasFading) host.setMainVolume(base)
    }

    private companion object {
        /** Our hand-over's seek may be confirmed again this soon after it. */
        const val ECHO_MS = 1_000L
    }
}
