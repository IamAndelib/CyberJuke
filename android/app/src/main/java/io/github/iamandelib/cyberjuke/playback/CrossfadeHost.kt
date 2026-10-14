package io.github.iamandelib.cyberjuke.playback

import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.PlayerMessage
import io.github.iamandelib.cyberjuke.net.NetBlock

/** The item a crossfade goes into: this one again on Repeat one (as Metrolist), else the next; C.INDEX_UNSET when none. */
internal fun crossfadeTarget(p: Player): Int =
    if (p.repeatMode == Player.REPEAT_MODE_ONE) p.currentMediaItemIndex else p.nextMediaItemIndex

/**
 * [Crossfader.Host] over the service's players: the [main] one (the session's) and, during a fade,
 * the [incoming] one. Position messages are the main player's own ([PlayerMessage]: delivered as
 * playback passes a position, no timer). Volumes are the players' own ([ExoPlayer.setVolume]),
 * which the session's controllers hear of: the notification and the platform session ignore
 * them, and the JukePlayer plugin sends the page no state for them (bridge/StateEvents).
 *
 * The audio focus is ExoPlayer's: the main player keeps it through the fade (a call or another
 * app's audio pauses it, and the incoming one follows: CrossfadeEvents), and the incoming one,
 * which doesn't handle it until the hand-over, then takes it (the old one goes anyway). Ducking
 * (a navigation prompt) applies to the main one only.
 *
 * Skipped and started fades are logged as warnings (R8 keeps those, see proguard-rules.pro), with
 * no ids: `adb logcat -s CyberJukeCrossfade:W`.
 */
@OptIn(UnstableApi::class)
internal class ExoCrossfadeHost(
    private val handler: Handler,
    private val main: () -> ExoPlayer?,
    private val incoming: () -> ExoPlayer?,
    /** Settings → Gapless playback, as the service has it. */
    private val gapless: () -> Boolean,
    /** PlaybackService.startIncoming. */
    private val start: () -> Boolean,
    /** PlaybackService.handOver. */
    private val hand: () -> Unit,
    /** PlaybackService.dropIncoming. */
    private val drop: () -> Unit,
) : Crossfader.Host {
    private val messages = ArrayList<PlayerMessage>(1)
    private val window = Timeline.Window()

    override fun facts(settingMs: Long): CrossfadePlan.Facts {
        val p = main() ?: return CrossfadePlan.Facts(settingMs, playing = false, repeatOne = false, hasNext = false, outage = false)
        val target = crossfadeTarget(p)
        // The album each was opened from (PlayerShared.toMediaItem); a track without one belongs to
        // none, and a track into its own start (Repeat one) to no album's run.
        val album = p.currentMediaItem?.mediaMetadata?.albumTitle?.takeIf { it.isNotEmpty() }
        val targetAlbum = if (target == C.INDEX_UNSET || target == p.currentMediaItemIndex || target >= p.mediaItemCount) {
            null
        } else {
            p.getMediaItemAt(target).mediaMetadata.albumTitle
        }
        return CrossfadePlan.Facts(
            settingMs = settingMs,
            playing = p.playWhenReady && p.playbackState == Player.STATE_READY &&
                p.playbackSuppressionReason == Player.PLAYBACK_SUPPRESSION_REASON_NONE,
            repeatOne = p.repeatMode == Player.REPEAT_MODE_ONE,
            hasNext = p.nextMediaItemIndex != C.INDEX_UNSET,
            outage = NetBlock.waitingForNetwork() || NetBlock.isBlocked(),
            gapless = gapless(),
            sameAlbum = album != null && album.toString() == targetAlbum?.toString(),
            // Prepared by the main player (Crossfade loads the next track ahead): its length is known.
            nextReady = nextDurationMs() > 0L,
        )
    }

    override fun durationMs(): Long = main()?.duration?.takeIf { it != C.TIME_UNSET && it > 0L } ?: -1L

    override fun nextDurationMs(): Long {
        val p = main() ?: return -1L
        val target = crossfadeTarget(p)
        val t = p.currentTimeline
        if (target == C.INDEX_UNSET || target >= t.windowCount) return -1L
        return t.getWindow(target, window).durationMs.takeIf { it != C.TIME_UNSET } ?: -1L
    }

    override fun positionMs(): Long = main()?.currentPosition?.coerceAtLeast(0L) ?: 0L

    override fun currentItem(): Any? {
        val p = main() ?: return null
        val t = p.currentTimeline
        val index = p.currentMediaItemIndex
        if (t.isEmpty || index >= t.windowCount) return null
        return t.getWindow(index, window).uid
    }

    override fun at(positionMs: Long, action: () -> Unit) {
        val p = main() ?: return
        messages.add(
            p.createMessage { _, _ -> action() }
                .setLooper(Looper.getMainLooper())
                .setPosition(p.currentMediaItemIndex, positionMs)
                .setDeleteAfterDelivery(true)
                .send(),
        )
    }

    override fun cancelAll() {
        messages.forEach { it.cancel() }
        messages.clear()
    }

    override fun startIncoming(): Boolean = start()

    override fun incomingIsNext(): Boolean {
        val p = main() ?: return false
        val target = crossfadeTarget(p)
        if (target == C.INDEX_UNSET || target >= p.mediaItemCount) return false
        return incoming()?.currentMediaItem == p.getMediaItemAt(target)
    }

    override fun handOver() = hand()

    override fun dropIncoming() = drop()

    override fun resumeMain() {
        main()?.play()
    }

    override val mainPlaying: Boolean get() = main()?.isPlaying == true

    override val incomingPlaying: Boolean get() = incoming()?.isPlaying == true

    override val mainVolume: Float get() = main()?.volume ?: 1f

    override fun setMainVolume(v: Float) {
        main()?.volume = v.coerceIn(0f, 1f)
    }

    override fun setIncomingVolume(v: Float) {
        incoming()?.volume = v.coerceIn(0f, 1f)
    }

    override fun setIncomingPlayWhenReady(playing: Boolean) {
        incoming()?.playWhenReady = playing
    }

    override fun post(delayMs: Long, r: Runnable) {
        handler.postDelayed(r, delayMs)
    }

    override fun remove(r: Runnable) = handler.removeCallbacks(r)

    override fun skipped(why: CrossfadePlan.Skip) {
        Log.w(TAG, "Crossfade skipped: $why")
    }

    override fun started(fadeMs: Long) {
        Log.w(TAG, "Crossfade started: $fadeMs ms")
    }

    companion object {
        const val TAG = "CyberJukeCrossfade"
    }
}

/**
 * The main player's events, as [Crossfader] wants them. On whichever player is the main one
 * (PlaybackService.adopt), and its first listener: its stop at a track's end during a fade is
 * handed over before anyone else hears of it.
 */
internal class CrossfadeEvents(private val fader: Crossfader) : Player.Listener {
    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) = fader.onJump()

    override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
        when (reason) {
            Player.DISCONTINUITY_REASON_SEEK, Player.DISCONTINUITY_REASON_SKIP, Player.DISCONTINUITY_REASON_REMOVE -> fader.onJump()
        }
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
        when (playbackState) {
            Player.STATE_IDLE, Player.STATE_ENDED -> fader.onHalted()
            // The length may be known now.
            Player.STATE_READY -> fader.arm()
        }
    }

    override fun onPlayerError(error: PlaybackException) = fader.onHalted()

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) fader.onPlaying()
    }

    /** Its stop at the end of its track during a fade (Player.setPauseAtEndOfMediaItems). */
    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        if (reason == Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM) fader.onMainEnded()
    }

    /** Paused or played, a call or another app's audio holding it back, or letting go. */
    override fun onEvents(player: Player, events: Player.Events) {
        if (events.containsAny(Player.EVENT_PLAY_WHEN_READY_CHANGED, Player.EVENT_PLAYBACK_SUPPRESSION_REASON_CHANGED)) {
            fader.onPlayWanted(player.playWhenReady && player.playbackSuppressionReason == Player.PLAYBACK_SUPPRESSION_REASON_NONE)
        }
    }

    /**
     * The list changed, or a length became known. An edit of the list or of its order is told by
     * the service once its queue has arranged it (PlaybackService.PlayerListener): the order a
     * shuffled insert lands in first isn't the one it keeps.
     */
    override fun onTimelineChanged(timeline: Timeline, reason: Int) {
        if (reason != Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) fader.onListChanged()
    }

    override fun onRepeatModeChanged(repeatMode: Int) = fader.onListChanged()
}

/** The incoming player's events before the hand-over: it plays (the ramp may go on), or it failed. */
internal class IncomingEvents(private val fader: Crossfader) : Player.Listener {
    override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) fader.onPlaying()
    }

    override fun onPlayerError(error: PlaybackException) {
        Log.w(ExoCrossfadeHost.TAG, "Crossfade: the next track failed: ${error.errorCodeName}")
        fader.onIncomingFailed()
    }
}
