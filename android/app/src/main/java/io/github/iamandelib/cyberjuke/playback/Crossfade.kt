package io.github.iamandelib.cyberjuke.playback

/**
 * Crossfade (Settings → Crossfade), after Metrolist (MusicService's scheduleCrossfade,
 * startCrossfade and performCrossfadeSwap): a fade's length before a track's end, a second player
 * starts the next track from its start, silent, and fades in while the old one plays out its own
 * end and fades out. Media3 has no crossfade of its own (as of 1.11). Nothing is lined up and the
 * next track needn't be buffered: if it needs a moment to start, the fade waits for it.
 *
 * Unlike Metrolist, the media session (the title in the app, the notification and the lock screen,
 * and the controls) stays with the old track until it ends, and only then moves to the new player
 * (Crossfader.Host.handOver): what shows is the track that's ending, until it has.
 * Pure (CrossfadeTest): when to fade, how long, and the curve.
 */
internal object CrossfadePlan {
    /** The setting's choices: Off, 3 s, 6 s and 10 s. */
    val CHOICES_MS = listOf(0, 3_000, 6_000, 10_000)

    /** A shorter fade isn't worth one (a fade shrunk to fit a short track). */
    const val MIN_FADE_MS = 1_000L

    /** The volume steps a fade takes (Metrolist's 20). */
    const val STEPS = 20

    /**
     * A fade that starts late (a seek or a resume past its start) starts this far ahead of the
     * position: a position message needs a position still to come.
     */
    const val LATE_START_MS = 100L

    /**
     * A late fade needs this much of the track left: with less, the old player may already have
     * read its end into the audio pipeline, and asking it to stop there would flush it (a gap).
     */
    const val LATE_MIN_MS = 2_000L

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

    /**
     * Where the playing track (at [positionMs]) fades into the next one, and for how long. Already
     * past the fade's start (a seek or a resume near the end), a shorter fade over what is left,
     * from just ahead of the position ([LATE_START_MS]), so it still ends with the track; none
     * when less than [LATE_MIN_MS] is left. (Metrolist skips the fade then.)
     */
    fun trigger(settingMs: Long, durationMs: Long, nextDurationMs: Long, positionMs: Long): Trigger {
        if (settingMs <= 0L) return Trigger.No(Skip.OFF)
        if (durationMs <= 0L) return Trigger.No(Skip.UNKNOWN_LENGTH)
        val fade = fadeMs(settingMs, durationMs, nextDurationMs)
        if (fade == 0L) return Trigger.No(Skip.TOO_SHORT)
        val at = durationMs - fade
        if (positionMs < at) return Trigger.At(at, fade)
        val lateAt = positionMs + LATE_START_MS
        val left = durationMs - lateAt
        return if (left < LATE_MIN_MS) Trigger.No(Skip.TOO_LATE) else Trigger.At(lateAt, left)
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
        /**
         * The main player has prepared the track the fade goes into (its length is known). One that
         * can't play (removed, private, blocked) never is; fading into it would cut this track's
         * end short when it fails, so this track ends the usual way and the error rules skip it.
         */
        val nextReady: Boolean = true,
    )

    enum class Skip {
        OFF, UNKNOWN_LENGTH, TOO_SHORT, TOO_LATE,
        NOT_PLAYING, LAST, OUTAGE, SAME_ALBUM, FADING,

        /** No second player could be made. */
        NO_PLAYER,

        /** The track the fade goes into isn't prepared: it can't play, or the link is too slow. */
        NEXT_NOT_READY,
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
        !f.nextReady -> Skip.NEXT_NOT_READY
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
 * CROSSING → RISING):
 * - CROSSING: [Host.startIncoming], a second player plays the next track from its start, silent,
 *   outside the session; the session's player (the main one) stops at its own track's end. Then
 *   [CrossfadePlan.STEPS] volume steps, relative to the main player's own volume ([base]): the
 *   incoming one fades in, the main one out. The main one keeps the session, its audio focus and
 *   the controls: the incoming one follows its pauses and calls ([onPlayWanted]).
 * - At the main track's end ([onMainEnded]), or the ramp's if that comes first, [Host.handOver]:
 *   the incoming player becomes the session's and the old one goes.
 * - RISING: what is left of the ramp, on the new main player alone.
 *
 * The steps are the only timer and run only while the incoming player plays: while it buffers, is
 * paused or held back, the ramp waits ([onPlaying]). A seek, a skip, a new list, the main player
 * stopping or failing, another setting, or an edit that changes the next track stops a fade at
 * once ([stop]): the incoming player goes ([Host.dropIncoming]) and the main one is at full volume
 * (after the hand-over: the new track is). The incoming track failing stops it the same way: the
 * old one plays to its end and on, as with Crossfade Off.
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

        /**
         * A second player plays the track the fade goes into from its start, at volume 0, outside
         * the session; the main player will stop at its track's end ([onMainEnded]). False: none
         * could be made, nothing changed.
         */
        fun startIncoming(): Boolean

        /** The incoming player still plays the track after the main one's (an edit may have changed it). */
        fun incomingIsNext(): Boolean

        /** The incoming player becomes the main one, with the session (its list brought in step); the old one goes. */
        fun handOver()

        /** The incoming player goes before the hand-over; the main one plays on past its track's end. */
        fun dropIncoming()

        /** The main player plays on (it stopped at its track's end for a fade that was dropped meanwhile). */
        fun resumeMain()

        /** The main player plays (its sound comes out). */
        val mainPlaying: Boolean

        /** A call or another app's audio holds the main player back (it plays on by itself once that ends). */
        val mainHeldBack: Boolean

        /** The incoming player plays. */
        val incomingPlaying: Boolean

        val mainVolume: Float

        fun setMainVolume(v: Float)

        fun setIncomingVolume(v: Float)

        fun setIncomingPlayWhenReady(playing: Boolean)

        fun post(delayMs: Long, r: Runnable)

        fun remove(r: Runnable)

        /** A fade that didn't happen, and why (logged: [CrossfadePlan.Skip]). */
        fun skipped(why: CrossfadePlan.Skip)

        /** A fade of [fadeMs] started (logged). */
        fun started(fadeMs: Long)
    }

    enum class Phase { NONE, CROSSING, RISING }

    var phase = Phase.NONE
        private set

    private var settingMs = (CrossfadePlan.valid(settingMs) ?: 0).toLong()

    /** Bumped by every [arm]: a message set before does nothing. */
    private var generation = 0

    /** The item the message was set for, and the fade it was set with. */
    private var item: Any? = null
    private var armedFadeMs = 0L

    /** Inside our own host calls: the players' events they cause are ours, not the user's. */
    private var busy = false

    /** The main player's own volume when the fade started: the fade's volumes are relative to it. */
    private var base = 1f
    private var step = 0
    private var stepMs = 0L

    /** The ramp waits for the incoming player to play ([onPlaying]). */
    private var waiting = false

    private val stepTask = Runnable { step() }

    /**
     * The item a fade was refused or failed for: not tried again for it until the user seeks or
     * skips ([onJump]) or changes the setting. A track's last seconds re-arm on every READY, play
     * and list change, and each try of a failing track would build a player again.
     */
    private var refusedFor: Any? = null

    /** The last item and reason a TOO_SHORT or TOO_LATE was told for (each is told once). */
    private var noted: Pair<Any?, CrossfadePlan.Skip>? = null

    /** The setting (anything but [CrossfadePlan.CHOICES_MS] is Off). Changed, a fade under way stops. */
    fun setSetting(ms: Int) {
        val v = (CrossfadePlan.valid(ms) ?: 0).toLong()
        if (v == settingMs) return
        settingMs = v
        refusedFor = null
        stop()
        arm()
    }

    // ---- the main player's events --------------------------------------------------------

    /**
     * Sets the current track's message (again): its length, the next track, the setting or the
     * position may have changed. Not while crossing: that track's fade is under way.
     */
    fun arm() {
        if (busy || phase == Phase.CROSSING) return
        host.cancelAll()
        val g = ++generation
        val current = host.currentItem()
        item = null
        if (current == null || current == refusedFor) return
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

    /** A new current item, a seek, a skip or a removal on the main player: a fade stops at once. */
    fun onJump() {
        if (busy) return
        refusedFor = null
        stop()
        arm()
    }

    /** The list, its order or the repeat mode changed, or a length became known. */
    fun onListChanged() {
        if (busy) return
        // Edits during a fade go to the main player; the hand-over brings the incoming one in step,
        // unless the track it plays is no longer the next.
        if (phase == Phase.CROSSING) {
            if (!host.incomingIsNext()) stop()
            return
        }
        arm()
    }

    /** The main player stopped, ended or failed. */
    fun onHalted() {
        if (busy) return
        stop()
    }

    /** Play wanted and nothing holding it back (a pause, a call, another app's audio): [wanted]. */
    fun onPlayWanted(wanted: Boolean) {
        if (busy) return
        if (phase == Phase.CROSSING) host.setIncomingPlayWhenReady(wanted)
        if (wanted) arm()
    }

    /**
     * The main player stopped at its track's end, as asked: the incoming one takes over. Only a
     * fade asks for that stop, but it is taken on the playback thread: one that arrives after its
     * fade was dropped (an edit, a seek, the incoming track failing) must not leave the music
     * paused there.
     */
    fun onMainEnded() {
        if (busy) return
        if (phase == Phase.CROSSING) handOver() else host.resumeMain()
    }

    /**
     * A queue edit of the user's comes, and goes after the track the main player plays: while
     * crossing, the incoming one takes over first, so it is the one played next to (and an
     * "Add to queue" doesn't take the place of the track already fading in). Not while a call
     * holds the main player back: only it would play on after the call (the incoming one never
     * asked for the audio focus), so the edit stops the fade as any other would ([onListChanged]).
     */
    fun settle() {
        if (busy || phase != Phase.CROSSING || host.mainHeldBack) return
        handOver()
    }

    /** The playing player (the incoming one while crossing) plays: a ramp that waited goes on. */
    fun onPlaying() {
        if (busy || phase == Phase.NONE || !waiting) return
        waiting = false
        step()
    }

    /** The incoming track failed before the hand-over: the old one plays on, as with Crossfade Off. */
    fun onIncomingFailed() {
        if (busy || phase != Phase.CROSSING) return
        refusedFor = host.currentItem()
        stop()
    }

    /** The service ends: nothing may outlive it. */
    fun release() {
        stop()
        host.remove(stepTask)
        host.cancelAll()
        generation++
    }

    // ---- the fade -------------------------------------------------------------------------

    private fun fire(g: Int) {
        if (g != generation || host.currentItem() != item) return
        val why = CrossfadePlan.decide(host.facts(settingMs).copy(fading = phase != Phase.NONE))
        if (why != null) {
            refuse(why)
            return
        }
        base = host.mainVolume
        if (!ours { host.startIncoming() }) {
            refuse(CrossfadePlan.Skip.NO_PLAYER)
            return
        }
        phase = Phase.CROSSING
        step = 0
        stepMs = CrossfadePlan.stepMs(armedFadeMs)
        waiting = false
        host.started(armedFadeMs)
        step()
    }

    private fun step() {
        if (phase == Phase.NONE) return
        // Not playing (buffering its start, paused, a call): no step until it does.
        if (!(if (phase == Phase.CROSSING) host.incomingPlaying else host.mainPlaying)) {
            waiting = true
            return
        }
        if (step >= CrossfadePlan.STEPS) {
            finish()
            return
        }
        val p = step.toFloat() / CrossfadePlan.STEPS
        if (phase == Phase.CROSSING) {
            host.setIncomingVolume(base * CrossfadePlan.fadeIn(p))
            host.setMainVolume(base * CrossfadePlan.fadeOut(p))
        } else {
            host.setMainVolume(base * CrossfadePlan.fadeIn(p))
        }
        step++
        host.post(stepMs, stepTask)
    }

    /** The incoming player takes over; the ramp goes on with it alone. */
    private fun handOver() {
        ours { host.handOver() }
        phase = Phase.RISING
        // The new track's own fade.
        arm()
    }

    /** The ramp is over: before the main track's end (the old one is silent now), the hand-over too. */
    private fun finish() {
        if (phase == Phase.CROSSING) handOver()
        end()
    }

    /** Ends a fade at once: before the hand-over the incoming player goes, and whichever plays is at full volume. */
    private fun stop() {
        when (phase) {
            Phase.NONE -> return
            Phase.CROSSING -> ours { host.dropIncoming() }
            Phase.RISING -> Unit
        }
        end()
    }

    private fun end() {
        host.remove(stepTask)
        waiting = false
        phase = Phase.NONE
        host.setMainVolume(base)
    }

    private inline fun <T> ours(block: () -> T): T {
        busy = true
        try {
            return block()
        } finally {
            busy = false
        }
    }

    /** No fade for this track, and why; not tried again for it on its own ([refusedFor]). */
    private fun refuse(why: CrossfadePlan.Skip) {
        // A fade under way (the last one still rising) is no refusal of this track's.
        if (why != CrossfadePlan.Skip.FADING) refusedFor = item
        note(why, item)
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
