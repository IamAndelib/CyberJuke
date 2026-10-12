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

    /**
     * The tail plays this long, muted, before the hand-over: its sound is already flowing then,
     * and it has time to be lined up with the main player ([TailAlign]): to settle and be
     * measured, and over a Bluetooth output's start delay once more after a seek.
     */
    const val PREROLL_MS = 2_500L

    /** The hand-over itself: the outgoing track moves from the main player to the tail over this long. */
    const val SWAP_MS = 150L

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
 * Lines the tail up with the main player during the preroll. A player's position counts what
 * has been heard, so a tail started at the main player's position lags it by its own start
 * delay (the output's latency: tens of ms on the speaker, a few hundred over Bluetooth), and the
 * hand-over would play that sliver twice.
 *
 * Fed both positions every step. A position is only an estimate at first (Media3 trusts the
 * output's timestamps after up to half a second, then corrects slowly), and each read may be a
 * few ms old, so the drift (main − tail) is only measured once the tail has run steadily for
 * [SETTLE_MS], as the median of its last [SAMPLES] samples. Over [ALIGNED_MS], the tail is sent
 * ahead by the delay learned so far (a seek starts it again, with the same delay), at most
 * [MAX_SEEKS] times, and only while there is time to settle and measure again before the swap
 * (never in its last [NO_SEEK_MS]): after that, and once it was lined up, it only judges. The
 * hand-over only happens within [HAND_OVER_MS] (the swap's ramp hides that much). Pure.
 */
internal class TailAlign {
    sealed interface Step {
        /** Not measured yet, or only judging now. */
        data object Wait : Step

        /** Seek the tail here (a muted tail: nobody hears it). */
        data class Seek(val toMs: Long) : Step

        data object Aligned : Step
    }

    /** The drift, main − tail, in ms (the median of the latest samples); null until measured (again, after a seek). */
    var driftMs: Long? = null
        private set

    var seeks = 0
        private set

    /** How far ahead of the main player the tail must start: its start delay, learned. */
    private var leadMs = 0L
    private var lastTailMs: Long? = null

    /** When the tail was first seen running steadily; -1 while it isn't. */
    private var runningSince = -1L

    /** Samples in a row without progress. */
    private var still = 0
    private val samples = ArrayDeque<Long>()
    private var aligned = false

    /** A step's sample, at [now] (the clock), with [toSwapMs] left until the swap. */
    fun sample(now: Long, mainMs: Long, tailMs: Long, toSwapMs: Long): Step {
        val advancing = lastTailMs?.let { tailMs - it >= MIN_ADVANCE_MS } == true
        lastTailMs = tailMs
        if (!advancing) {
            // One odd read is skipped; not started yet, or stalled: what was gathered is void.
            if (++still >= STALL_STEPS) {
                runningSince = -1L
                samples.clear()
            }
            return Step.Wait
        }
        still = 0
        if (runningSince < 0L) runningSince = now
        if (now - runningSince < SETTLE_MS) return Step.Wait
        samples.addLast(mainMs - tailMs)
        if (samples.size > SAMPLES) samples.removeFirst()
        if (samples.size < MIN_SAMPLES) return Step.Wait
        val d = samples.sorted()[samples.size / 2]
        driftMs = d
        if (kotlin.math.abs(d) <= ALIGNED_MS) {
            aligned = true
            return Step.Aligned
        }
        if (aligned || seeks >= MAX_SEEKS) return Step.Wait
        val lead = leadMs + d
        // Time to start again, settle and measure before the swap, or only judge from now on.
        if (toSwapMs < maxOf(NO_SEEK_MS, kotlin.math.abs(lead) + SETTLE_MS + MIN_SAMPLES * STEP_MS)) return Step.Wait
        seeks++
        leadMs = lead
        lastTailMs = null
        runningSince = -1L
        still = 0
        samples.clear()
        driftMs = null
        return Step.Seek(mainMs + leadMs)
    }

    /** Close enough to hand over without a jump anyone would hear. */
    val handOverOk: Boolean get() = driftMs?.let { kotlin.math.abs(it) <= HAND_OVER_MS } == true

    companion object {
        const val ALIGNED_MS = 15L
        const val HAND_OVER_MS = 30L
        const val MAX_SEEKS = 2

        /** The tail runs steadily this long before its drift counts. */
        const val SETTLE_MS = 600L

        /** The drift is the median of this many latest samples, from [MIN_SAMPLES] on. */
        const val SAMPLES = 5
        const val MIN_SAMPLES = 3

        /** No seek this close to the swap: the tail couldn't settle again in time. */
        const val NO_SEEK_MS = 400L

        /** A running tail moves about a step between samples; a waiting one doesn't. */
        const val MIN_ADVANCE_MS = 10L

        /** This many samples in a row without progress: it isn't running (yet, or any more). */
        const val STALL_STEPS = 2

        private const val STEP_MS = CrossfadePlan.STEP_MS
    }
}

/**
 * Runs the crossfade over the main player ([Host]) and a tail player ([Tail]), on the main
 * thread. Pure (CrossfadeTest, with fakes); the Android side is ExoCrossfadeHost.
 *
 * For each track, a position message ([Host.at], no timer) at [CrossfadePlan.primeAtMs]:
 * - prime: [CrossfadePlan.decide]; on a fade, the tail is made (paused, at the hand-over minus
 *   [CrossfadePlan.PREROLL_MS]) and two more position messages are set;
 * - preroll: the tail plays, muted, and is lined up with the main player ([TailAlign]); not
 *   ready by then: no fade, the tail goes;
 * - swap ([CrossfadePlan.SWAP_MS] before the fade): only if the tail is lined up and the next
 *   track still ready, the outgoing track moves from the main player to the tail in three short
 *   steps (a linear ramp: the two play the same sound), then the main player, silent, moves on
 *   to the next track ([Host.advance]) and the fade runs.
 *
 * Steps every [CrossfadePlan.STEP_MS] are the only timer, only from the preroll to the fade's
 * end. Volumes are relative to the main player's own volume, read at each step.
 *
 * A pause, seek, skip, stop, a new current track, a call or other loss of audio focus, a stall
 * of the outgoing track or a tail error before the fade stops it at once: the tail goes, its step
 * is removed and the main player's volume is whole again ([stop]). A tail that fails or ends
 * during the fade just goes; the incoming track's fade-in runs on to the end. A change of the
 * next track, or of the repeat or shuffle mode, before the hand-over plans again; an edit of the
 * queue that leaves the next track as it was changes nothing. After the hand-over the fade goes
 * on (it no longer depends on the queue).
 */
internal class Crossfader(private val host: Host, settingMs: Int) {
    interface Host {
        /** The main player's facts for the plan. */
        fun facts(settingMs: Long): CrossfadePlan.Facts

        /** Identifies the main player's current item (stable across edits of the list); null when empty. */
        fun currentItem(): Any?

        /** Identifies the item that plays after the current one; null when none. */
        fun nextItem(): Any?

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

        /** At the swap: how well the tail was lined up ([driftMs], null: never measured), and whether it was handed over. */
        fun judged(driftMs: Long?, seeks: Int, handedOver: Boolean)
    }

    interface Tail {
        val isReady: Boolean

        /** What has been heard of it so far, as a player counts its position. */
        val positionMs: Long

        fun play()

        fun seekTo(positionMs: Long)

        fun setVolume(v: Float)

        fun release()
    }

    interface TailEvents {
        fun onTailEnded()

        fun onTailError()
    }

    enum class Phase { NONE, PRIMED, PREROLL, SWAP, FADING }

    var phase = Phase.NONE
        private set

    private var settingMs = (CrossfadePlan.valid(settingMs) ?: 0).toLong()

    /** Bumped by every new plan: a message of an older one does nothing. */
    private var generation = 0

    /** The item the messages were set for, and the next one the plan was made with. */
    private var item: Any? = null
    private var plannedNext: Any? = null

    /** The current item's prime is still to come (a message is set for it). */
    private var primePending = false

    private var tail: Tail? = null
    private var align = TailAlign()
    private var fadeMs = 0L
    private var startAtMs = 0L
    private var swapAt = 0L
    private var startedAt = 0L

    /** Inside our own [Host.advance]: its events are ours, not the user's. */
    private var advancing = false

    private val stepTask = Runnable { step() }

    /** Counts tails, so a released one's late event changes nothing. */
    private var tailNumber = 0

    private fun eventsOf(n: Int) = object : TailEvents {
        override fun onTailEnded() = tailGone(n)

        override fun onTailError() = tailGone(n)
    }

    /**
     * The tail ended or failed. During the fade it just goes (the fade-in runs on to its end,
     * no jump to full volume); before it, there is no fade.
     */
    private fun tailGone(n: Int) {
        if (n != tailNumber || tail == null) return
        if (phase == Phase.FADING) {
            tail?.release()
            tail = null
        } else {
            stop()
        }
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
        if (beforeHandOver()) stop()
    }

    /** READY: the length may be known now. */
    fun onReady() {
        if (advancing) return
        if (phase == Phase.NONE) arm()
    }

    /**
     * The list changed. Before the hand-over, only a different next track plans again (an
     * autoplay top-up after it, or the shuffle order put back as it was, keeps the tail).
     */
    fun onQueueChanged() {
        if (advancing) return
        if (beforeHandOver()) {
            if (host.nextItem() == plannedNext) return
            stop()
        }
        arm()
    }

    /** Repeat or shuffle changed: before the hand-over, plan again. */
    fun onOrderChanged() {
        if (advancing) return
        if (beforeHandOver()) stop()
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
        primePending = false
        generation++
    }

    // ---- the plan ------------------------------------------------------------------------

    private fun beforeHandOver() = phase == Phase.PRIMED || phase == Phase.PREROLL || phase == Phase.SWAP

    /**
     * Sets the current track's prime (a fade already running goes on: these messages are for
     * the track after it). Never while a tail is primed (callers stop it first).
     */
    private fun arm() {
        host.cancelAll()
        primePending = false
        val g = ++generation
        item = null
        if (settingMs <= 0L) return
        val primeAt = CrossfadePlan.primeAtMs(settingMs, host.durationMs()) ?: return
        item = host.currentItem() ?: return
        // Already past it (a resume or a seek near the end): prime now; decide() turns down what's too late.
        if (host.positionMs() >= primeAt) {
            prime(g)
        } else {
            primePending = true
            host.at(primeAt) { prime(g) }
        }
    }

    private fun current(g: Int) = g == generation && host.currentItem() == item

    private fun prime(g: Int) {
        if (g == generation) primePending = false
        // During a fade (a short track after it): the fade's end arms it again.
        if (!current(g) || phase != Phase.NONE) return
        val d = CrossfadePlan.decide(host.facts(settingMs))
        if (d !is CrossfadePlan.Decision.Fade) return
        val t = host.newTail(d.startAtMs - CrossfadePlan.PREROLL_MS, eventsOf(++tailNumber)) ?: return
        tail = t
        align = TailAlign()
        fadeMs = d.fadeMs
        startAtMs = d.startAtMs
        plannedNext = host.nextItem()
        phase = Phase.PRIMED
        host.at(d.startAtMs - CrossfadePlan.PREROLL_MS) { preroll(g) }
        host.at(d.startAtMs - CrossfadePlan.SWAP_MS) { swap(g) }
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
        host.post(CrossfadePlan.STEP_MS, stepTask)
    }

    private fun swap(g: Int) {
        if (!current(g) || phase != Phase.PREROLL) {
            if (beforeHandOver()) stop()
            return
        }
        // Not lined up (a jump would be heard), or the next track no longer ready: the track
        // ends the usual way.
        val ok = align.handOverOk && CrossfadePlan.canHandOver(host.facts(settingMs), fadeMs)
        host.judged(align.driftMs, align.seeks, ok)
        if (!ok) {
            stop()
            return
        }
        phase = Phase.SWAP
        swapAt = host.now()
    }

    private fun step() {
        val t = tail
        when (phase) {
            Phase.PREROLL -> {
                if (t == null) return
                val main = host.positionMs()
                val s = align.sample(host.now(), main, t.positionMs, startAtMs - CrossfadePlan.SWAP_MS - main)
                if (s is TailAlign.Step.Seek) t.seekTo(s.toMs)
            }
            Phase.SWAP -> {
                val base = host.baseVolume
                val s = CrossfadePlan.progress(host.now(), swapAt, CrossfadePlan.SWAP_MS)
                t?.setVolume(base * s)
                host.setMainVolume(base * (1f - s))
                if (s >= 1f && !handOver()) return
            }
            Phase.FADING -> {
                val base = host.baseVolume
                val p = CrossfadePlan.progress(host.now(), startedAt, fadeMs)
                if (p >= 1f) {
                    finish()
                    return
                }
                t?.setVolume(base * CrossfadePlan.outGain(p))
                host.setMainVolume(base * CrossfadePlan.inGain(p))
            }
            else -> return
        }
        host.post(CrossfadePlan.STEP_MS, stepTask)
    }

    /** The tail carries the outgoing track alone now: the main player, silent, moves on. */
    private fun handOver(): Boolean {
        host.setMainVolume(0f)
        phase = Phase.FADING
        startedAt = host.now()
        advancing = true
        try {
            host.advance()
        } catch (e: RuntimeException) {
            // Never left silent.
            advancing = false
            stop()
            return false
        } finally {
            advancing = false
        }
        // The next track's own prime, for the fade after this one.
        arm()
        return true
    }

    /** The fade is over: the tail goes; a prime that fell during it (a short track) is set again. */
    private fun finish() {
        stop()
        if (!primePending) arm()
    }

    /** Ends any fade at once: the tail goes, its step too, and the main player is at full volume. */
    private fun stop() {
        host.remove(stepTask)
        val t = tail
        tail = null
        val touchedMain = phase == Phase.SWAP || phase == Phase.FADING
        phase = Phase.NONE
        t?.release()
        if (touchedMain) host.setMainVolume(host.baseVolume)
    }

    private companion object {
        /** Our hand-over's seek may be confirmed again this soon after it. */
        const val ECHO_MS = 1_000L
    }
}
