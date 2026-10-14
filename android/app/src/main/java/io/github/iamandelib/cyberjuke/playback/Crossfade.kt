package io.github.iamandelib.cyberjuke.playback

/**
 * Crossfade (Settings → Crossfade), the way Metrolist does it (MusicService's scheduleCrossfade,
 * startCrossfade and performCrossfadeSwap): a fade's length before a track's end, a second player
 * starts the next track from its start, silent, and takes over the media session (the title, the
 * notification and the lock screen move on at once), and fades in while the old player plays out
 * its own end and fades out. Media3 has no crossfade of its own (as of 1.11). Nothing is lined up
 * and the next track needn't be buffered: if it needs a moment to start, the fade waits for it.
 * Pure (CrossfadeTest): when to fade, how long, and the curve.
 */
internal object CrossfadePlan {
    /** The setting's choices: Off, 3 s, 6 s and 10 s. */
    val CHOICES_MS = listOf(0, 3_000, 6_000, 10_000)

    /** A shorter fade isn't worth one (a fade shrunk to fit a short track). */
    const val MIN_FADE_MS = 1_000L

    /** The volume steps a fade takes (Metrolist's 20). */
    const val STEPS = 20

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

    sealed interface Trigger {
        /** Fade for [fadeMs] once the track plays through [atMs]: its end minus the fade. */
        data class At(val atMs: Long, val fadeMs: Long) : Trigger

        /** No fade for this track. */
        data class No(val why: Skip) : Trigger
    }

    /** Where the playing track (at [positionMs]) fades into the next one, and for how long. */
    fun trigger(settingMs: Long, durationMs: Long, nextDurationMs: Long, positionMs: Long): Trigger {
        if (settingMs <= 0L) return Trigger.No(Skip.OFF)
        if (durationMs <= 0L) return Trigger.No(Skip.UNKNOWN_LENGTH)
        val fade = fadeMs(settingMs, durationMs, nextDurationMs)
        if (fade == 0L) return Trigger.No(Skip.TOO_SHORT)
        val at = durationMs - fade
        // Already past it (a seek or a resume near the end): the track ends the usual way.
        if (positionMs >= at) return Trigger.No(Skip.TOO_LATE)
        return Trigger.At(at, fade)
    }

    /** The main player, as the crossfade sees it when a fade comes due. */
    data class Facts(
        val settingMs: Long,
        /** Playing now: play wanted, READY, nothing (a call, say) holding it back. */
        val playing: Boolean,
        val repeatOne: Boolean,
        val hasNext: Boolean,
        /** Waiting for the network, or a back-off. */
        val outage: Boolean,
        /** Settings → Gapless playback. */
        val gapless: Boolean = true,
        /** The playing track and the one the fade goes into are from one album (both say so). */
        val sameAlbum: Boolean = false,
        /** A fade (or the hand-over of the audio focus before one) is under way. */
        val fading: Boolean = false,
    )

    enum class Skip {
        OFF, UNKNOWN_LENGTH, TOO_SHORT, TOO_LATE,
        NOT_PLAYING, LAST, OUTAGE, SAME_ALBUM, FADING,

        /** No second player could be made. */
        NO_PLAYER,
    }

    /** A fade that came due: null to fade, else why not. */
    fun decide(f: Facts): Skip? = when {
        f.settingMs <= 0L -> Skip.OFF
        !f.playing -> Skip.NOT_PLAYING
        // Repeat one fades into its own start, as Metrolist does.
        !f.hasNext && !f.repeatOne -> Skip.LAST
        f.outage -> Skip.OUTAGE
        // Made to run into each other (Metrolist's "gapless" option is this rule).
        f.gapless && f.sameAlbum -> Skip.SAME_ALBUM
        f.fading -> Skip.FADING
        else -> null
    }

    /** The incoming track's gain at [p] (0 → 1): up fast, then gently (Metrolist's 1 − (1 − p)²). */
    fun fadeIn(p: Float): Float {
        val q = 1f - p.coerceIn(0f, 1f)
        return 1f - q * q
    }

    /** The outgoing track's gain at [p] (1 → 0): down fast, then gently ((1 − p)²). */
    fun fadeOut(p: Float): Float {
        val q = 1f - p.coerceIn(0f, 1f)
        return q * q
    }

    /** The time between two of a fade's [STEPS]. */
    fun stepMs(fadeMs: Long): Long = fadeMs / STEPS
}

/**
 * Runs the crossfade over the service's players ([Host]), on the main thread. Pure (CrossfadeTest,
 * with a fake host); the Android side is ExoCrossfadeHost.
 *
 * Armed for each track ([arm]): one position message ([Host.at], no timer) at
 * [CrossfadePlan.trigger]. When it comes due and [CrossfadePlan.decide] says fade (phases NONE →
 * YIELDING → FADING):
 * - the main player gives up its audio focus ([Host.yieldFocus]), so the new player's request
 *   takes nothing from it (a second request would make Android pause it);
 * - then [Host.swapToNext]: a new main player starts the next track, silent, and the old one keeps
 *   only its own track and fades;
 * - then [CrossfadePlan.STEPS] volume steps, relative to the old player's own volume ([base]): the
 *   new one fades in, the old one out, and is released at the end.
 *
 * The steps are the only timer and run only while the new player plays: while it buffers, is
 * paused or held back, the ramp waits ([onPlaying]). The old player plays when play is wanted
 * ([onPlayWanted]). A seek, a skip, a new list, the main player stopping or failing, or another
 * setting stops a fade at once ([stop]): the old track goes and the new one is at full volume.
 * The old track ending or failing by itself ([onFadingGone]) lets the ramp finish on the new one.
 */
internal class Crossfader(private val host: Host, settingMs: Int) {
    interface Host {
        /** The main player's facts for [CrossfadePlan.decide] (`fading`: false, the crossfader knows). */
        fun facts(settingMs: Long): CrossfadePlan.Facts

        /** The current track's length; <= 0 while unknown. */
        fun durationMs(): Long

        /** The length of the track the fade goes into (the next, or this one on Repeat one); <= 0 while unknown. */
        fun nextDurationMs(): Long

        fun positionMs(): Long

        /** Identifies the main player's current item (stable across edits of the list); null when empty. */
        fun currentItem(): Any?

        /** Runs [action] on the main thread when the main player's current item plays through [positionMs]. */
        fun at(positionMs: Long, action: () -> Unit)

        /** Cancels everything [at] set. */
        fun cancelAll()

        /** The main player gives up its audio focus; [then] runs once it has. */
        fun yieldFocus(then: () -> Unit)

        /** The main player handles its audio focus again (a fade that didn't happen). */
        fun reclaimFocus()

        /**
         * A new main player plays the track the fade goes into from its start, at volume 0, and has
         * the session; the old one keeps only its own track, fading. False: none could be made,
         * nothing changed.
         */
        fun swapToNext(): Boolean

        /** The main player plays (its sound comes out). */
        val mainPlaying: Boolean

        val mainVolume: Float

        fun setMainVolume(v: Float)

        fun setFadingVolume(v: Float)

        fun setFadingPlaying(playing: Boolean)

        /** The old player goes. */
        fun releaseFading()

        fun post(delayMs: Long, r: Runnable)

        fun remove(r: Runnable)

        /** A fade that didn't happen, and why (logged: [CrossfadePlan.Skip]). */
        fun skipped(why: CrossfadePlan.Skip)

        /** A fade of [fadeMs] started (logged). */
        fun started(fadeMs: Long)
    }

    enum class Phase { NONE, YIELDING, FADING }

    var phase = Phase.NONE
        private set

    private var settingMs = (CrossfadePlan.valid(settingMs) ?: 0).toLong()

    /** Bumped by every [arm]: a message set before does nothing. */
    private var generation = 0

    /** The item the message was set for, and the fade it was set with. */
    private var item: Any? = null
    private var armedFadeMs = 0L

    /** Counts focus hand-overs, so a late barrier of an abandoned one does nothing. */
    private var yields = 0

    /** Inside our own [Host.swapToNext]: the new player's events are ours, not the user's. */
    private var swapping = false

    /** The old player's own volume, read before the swap: the fade's volumes are relative to it. */
    private var base = 1f
    private var step = 0
    private var stepMs = 0L

    /** The old player is still there (it may end or fail before the ramp does). */
    private var fadingAlive = false

    /** The ramp waits for the new player to play ([onPlaying]). */
    private var waiting = false

    private val stepTask = Runnable { step() }

    /** The last item and reason a TOO_SHORT or TOO_LATE was told for (each is told once). */
    private var noted: Pair<Any?, CrossfadePlan.Skip>? = null

    /** The setting (anything but [CrossfadePlan.CHOICES_MS] is Off). Changed, a fade under way stops. */
    fun setSetting(ms: Int) {
        val v = (CrossfadePlan.valid(ms) ?: 0).toLong()
        if (v == settingMs) return
        settingMs = v
        stop()
        arm()
    }

    // ---- the main player's events --------------------------------------------------------

    /**
     * Sets the current track's message (again): its length, the next track, the setting or the
     * position may have changed. A fade under way goes on (the message is for the track after it).
     */
    fun arm() {
        if (swapping || phase == Phase.YIELDING) return
        host.cancelAll()
        val g = ++generation
        val current = host.currentItem()
        item = null
        if (current == null) return
        val t = CrossfadePlan.trigger(settingMs, host.durationMs(), host.nextDurationMs(), host.positionMs())
        if (t is CrossfadePlan.Trigger.No) {
            note(t.why, current)
            return
        }
        val at = t as CrossfadePlan.Trigger.At
        item = current
        armedFadeMs = at.fadeMs
        host.at(at.atMs) { fire(g) }
    }

    /** A new current item, a seek, a skip or a removal that isn't our swap's: a fade stops at once. */
    fun onJump() {
        if (swapping) return
        stop()
        arm()
    }

    /** The main player stopped, ended or failed. */
    fun onHalted() {
        if (swapping) return
        stop()
    }

    /** Play wanted and nothing holding it back (a pause, a call, another app's audio): [wanted]. */
    fun onPlayWanted(wanted: Boolean) {
        if (swapping) return
        when (phase) {
            Phase.FADING -> if (fadingAlive) host.setFadingPlaying(wanted)
            Phase.YIELDING -> if (!wanted) stop()
            Phase.NONE -> Unit
        }
        if (wanted) arm()
    }

    /** The main player plays: a ramp that waited for it goes on. */
    fun onPlaying() {
        if (swapping || phase != Phase.FADING || !waiting) return
        waiting = false
        step()
    }

    /** The old player played out its track, or failed: it goes, the ramp finishes on the new one. */
    fun onFadingGone() {
        if (phase != Phase.FADING || !fadingAlive) return
        fadingAlive = false
        host.releaseFading()
    }

    /** The service ends: nothing may outlive it. */
    fun release() {
        stop()
        host.remove(stepTask)
        host.cancelAll()
        generation++
        yields++
    }

    // ---- the fade -------------------------------------------------------------------------

    private fun fire(g: Int) {
        if (g != generation || host.currentItem() != item) return
        val why = CrossfadePlan.decide(host.facts(settingMs).copy(fading = phase != Phase.NONE))
        if (why != null) {
            note(why, item)
            return
        }
        val fade = armedFadeMs
        phase = Phase.YIELDING
        val y = ++yields
        host.yieldFocus { start(y, fade) }
    }

    /** The old player gave up its audio focus: swap, and the ramp starts once the new one plays. */
    private fun start(y: Int, fadeMs: Long) {
        if (phase != Phase.YIELDING || y != yields) return
        base = host.mainVolume
        swapping = true
        val swapped = try {
            host.swapToNext()
        } finally {
            swapping = false
        }
        if (!swapped) {
            phase = Phase.NONE
            host.reclaimFocus()
            note(CrossfadePlan.Skip.NO_PLAYER, item)
            return
        }
        phase = Phase.FADING
        fadingAlive = true
        step = 0
        stepMs = CrossfadePlan.stepMs(fadeMs)
        waiting = false
        host.started(fadeMs)
        // The new track's own fade.
        arm()
        step()
    }

    private fun step() {
        if (phase != Phase.FADING) return
        // Not playing (buffering its start, paused, a call): no step until it does.
        if (!host.mainPlaying) {
            waiting = true
            return
        }
        if (step >= CrossfadePlan.STEPS) {
            finish()
            return
        }
        val p = step.toFloat() / CrossfadePlan.STEPS
        host.setMainVolume(base * CrossfadePlan.fadeIn(p))
        if (fadingAlive) host.setFadingVolume(base * CrossfadePlan.fadeOut(p))
        step++
        host.post(stepMs, stepTask)
    }

    /** The fade is over (or stopped): the old player goes, the new one is at its own volume. */
    private fun finish() {
        host.remove(stepTask)
        waiting = false
        phase = Phase.NONE
        if (fadingAlive) {
            fadingAlive = false
            host.releaseFading()
        }
        host.setMainVolume(base)
    }

    /** Ends a fade at once, or the focus hand-over before one (the old player takes its focus back). */
    private fun stop() {
        when (phase) {
            Phase.NONE -> Unit
            Phase.YIELDING -> {
                phase = Phase.NONE
                host.reclaimFocus()
            }
            Phase.FADING -> finish()
        }
    }

    /** Tells a skipped fade: not Off or a length still unknown (the usual), and TOO_SHORT and TOO_LATE once per track. */
    private fun note(why: CrossfadePlan.Skip, about: Any?) {
        when (why) {
            CrossfadePlan.Skip.OFF, CrossfadePlan.Skip.UNKNOWN_LENGTH -> return
            CrossfadePlan.Skip.TOO_SHORT, CrossfadePlan.Skip.TOO_LATE -> {
                val key = about to why
                if (key == noted) return
                noted = key
            }
            else -> Unit
        }
        host.skipped(why)
    }
}
