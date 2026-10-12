package io.github.iamandelib.cyberjuke.playback

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.PlayerMessage
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.RenderersFactory
import androidx.media3.exoplayer.audio.MediaCodecAudioRenderer
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import io.github.iamandelib.cyberjuke.net.NetBlock

/**
 * [Crossfader.Host] over the service's ExoPlayer ([main]). Position messages are the player's
 * own ([PlayerMessage]: delivered as playback passes a position, no timer); the fade-in sets the
 * audio renderer's volume directly, as the player does for its own volume, so a fade raises no
 * volume events (each would be a state event to the page and to every controller).
 */
@OptIn(UnstableApi::class)
internal class ExoCrossfadeHost(
    private val context: Context,
    private val main: ExoPlayer,
    private val handler: Handler,
    /** The service's sources: the listening cache, then the network ([AudioCache.dataSourceFactory]). */
    private val dataSources: DataSource.Factory,
    private val audioAttributes: AudioAttributes,
) : Crossfader.Host {
    private val messages = ArrayList<PlayerMessage>(3)
    private val window = Timeline.Window()

    override fun facts(settingMs: Long): CrossfadePlan.Facts {
        val p = main
        val next = p.nextMediaItemIndex
        val duration = durationMs()
        val position = p.currentPosition.coerceAtLeast(0L)
        val nextDuration = if (next == C.INDEX_UNSET || next >= p.currentTimeline.windowCount) {
            -1L
        } else {
            p.currentTimeline.getWindow(next, window).durationMs.takeIf { it != C.TIME_UNSET } ?: -1L
        }
        val left = if (duration > 0L) (duration - position).coerceAtLeast(0L) else 0L
        return CrossfadePlan.Facts(
            settingMs = settingMs,
            playing = p.playWhenReady && p.playbackState == Player.STATE_READY &&
                p.playbackSuppressionReason == Player.PLAYBACK_SUPPRESSION_REASON_NONE,
            repeatOne = p.repeatMode == Player.REPEAT_MODE_ONE,
            // A one-track list on Repeat all starts over: no fade into itself.
            hasNext = next != C.INDEX_UNSET && next != p.currentMediaItemIndex,
            outage = NetBlock.waitingForNetwork() || NetBlock.isBlocked(),
            ours = p.currentMediaItem?.localConfiguration?.uri?.scheme == JukeUris.SCHEME,
            durationMs = duration,
            positionMs = position,
            nextDurationMs = nextDuration,
            nextBufferedMs = (p.totalBufferedDuration - left).coerceAtLeast(0L),
        )
    }

    override fun currentItem(): Any? = uidOf(main.currentMediaItemIndex)

    override fun nextItem(): Any? = uidOf(main.nextMediaItemIndex)

    private fun uidOf(index: Int): Any? {
        val t = main.currentTimeline
        if (t.isEmpty || index == C.INDEX_UNSET || index >= t.windowCount) return null
        return t.getWindow(index, window).uid
    }

    override fun positionMs(): Long = main.currentPosition.coerceAtLeast(0L)

    override fun durationMs(): Long = main.duration.takeIf { it != C.TIME_UNSET && it > 0L } ?: -1L

    override fun at(positionMs: Long, action: () -> Unit) {
        messages.add(
            main.createMessage { _, _ -> action() }
                .setLooper(Looper.getMainLooper())
                .setPosition(main.currentMediaItemIndex, positionMs)
                .setDeleteAfterDelivery(true)
                .send(),
        )
    }

    override fun cancelAll() {
        messages.forEach { it.cancel() }
        messages.clear()
    }

    override fun post(delayMs: Long, r: Runnable) {
        handler.postDelayed(r, delayMs)
    }

    override fun remove(r: Runnable) = handler.removeCallbacks(r)

    override fun now(): Long = SystemClock.elapsedRealtime()

    override val baseVolume: Float get() = main.volume

    /** Renderer.MSG_SET_VOLUME to the audio renderers, on the playback thread, after anything sent before. */
    override fun setMainVolume(v: Float) {
        val volume = v.coerceIn(0f, 1f)
        for (i in 0 until main.rendererCount) {
            if (main.getRendererType(i) != C.TRACK_TYPE_AUDIO) continue
            send(main.getRenderer(i), volume)
            main.getSecondaryRenderer(i)?.let { send(it, volume) }
        }
    }

    private fun send(renderer: Renderer, volume: Float) {
        main.createMessage(renderer).setType(Renderer.MSG_SET_VOLUME).setPayload(volume).send()
    }

    override fun advance() = main.seekToNextMediaItem()

    override fun newTail(positionMs: Long, events: Crossfader.TailEvents): Crossfader.Tail? {
        val item = main.currentMediaItem ?: return null
        val ytId = JukeUris.ytIdOf(item) ?: return null
        // The file the track played (an Auto step at the transition must not swap it mid-song),
        // and only an audio-only one (a muxed fallback isn't in the listening cache).
        val served = StreamResolver.lastServed(ytId)?.takeIf { it.audioOnly && it.itag > 0 } ?: return null
        val itag = served.itag
        return try {
            CrossfadeTail(context, main.playbackLooper, dataSources, audioAttributes, item, itag, positionMs, events)
        } catch (e: RuntimeException) {
            Log.w(TAG, "No crossfade tail: ${e.javaClass.simpleName}")
            null
        }
    }

    private companion object {
        const val TAG = "CyberJukeCrossfade"
    }
}

/**
 * The outgoing track's last seconds during a crossfade: a second, bare ExoPlayer that exists only
 * then (made at the prime, released when the fade ends or stops). Audio only (one renderer), a
 * small buffer, the main player's playback thread (no thread of its own), the same sources (the
 * listening cache serves the bytes the main player already fetched), the same file ([itag], see
 * [YtDataSpecResolver.Pinned]: only what is cached, never an extraction), and no retries (a
 * failed load means no fade). Never in the media session; no audio focus, no becoming-noisy
 * handling and no wake lock of its own: it only plays while the main player does, and stops
 * with it.
 */
@OptIn(UnstableApi::class)
internal class CrossfadeTail(
    context: Context,
    playbackLooper: Looper,
    dataSources: DataSource.Factory,
    audioAttributes: AudioAttributes,
    item: MediaItem,
    itag: Int,
    positionMs: Long,
    private val events: Crossfader.TailEvents,
) : Crossfader.Tail {
    private val player: ExoPlayer

    init {
        val app = context.applicationContext
        val audioOnly = RenderersFactory { handler, _, audioListener, _, _ ->
            arrayOf<Renderer>(MediaCodecAudioRenderer(app, MediaCodecSelector.DEFAULT, handler, audioListener))
        }
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(BUFFER_MS, BUFFER_MS, START_MS, START_MS)
            .setTargetBufferBytes(BUFFER_BYTES)
            .build()
        val sources = DefaultMediaSourceFactory(ResolvingDataSource.Factory(dataSources, YtDataSpecResolver.Pinned(itag)))
            .setLoadErrorHandlingPolicy(NoRetry)
        player = ExoPlayer.Builder(app)
            .setRenderersFactory(audioOnly)
            .setMediaSourceFactory(sources)
            .setLoadControl(loadControl)
            .setPlaybackLooper(playbackLooper)
            .setAudioAttributes(audioAttributes, /* handleAudioFocus = */ false)
            .setHandleAudioBecomingNoisy(false)
            // No wake lock of its own (the default would hold one): the main player's covers it.
            .setWakeMode(C.WAKE_MODE_NONE)
            .setUsePlatformDiagnostics(false)
            .build()
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED) events.onTailEnded()
            }

            override fun onPlayerError(error: PlaybackException) {
                Log.w(TAG, "Crossfade tail failed: ${error.errorCodeName}")
                events.onTailError()
            }
        })
        player.volume = 0f
        // Seeked before it plays: it starts where the hand-over will be.
        player.setMediaItem(item, positionMs)
        player.prepare()
    }

    override val isReady: Boolean get() = player.playbackState == Player.STATE_READY

    override val positionMs: Long get() = player.currentPosition

    override fun play() = player.play()

    override fun seekTo(positionMs: Long) = player.seekTo(positionMs)

    override fun setVolume(v: Float) {
        player.volume = v.coerceIn(0f, 1f)
    }

    override fun release() = player.release()

    /** A fade is optional: a failed load is never retried, the tail just goes (no fade). */
    private object NoRetry : DefaultLoadErrorHandlingPolicy() {
        override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long = C.TIME_UNSET
    }

    private companion object {
        const val TAG = "CyberJukeCrossfade"

        /** At most a fade (10 s) and its lead are left to play: buffer about that, no more. */
        const val BUFFER_MS = 15_000

        /** Ready once this much is there (the cache serves it at once). */
        const val START_MS = 500

        /** 15 s of audio is well under 1 MB; a muxed fallback stays capped too. */
        const val BUFFER_BYTES = 2 * 1024 * 1024
    }
}

/** The main player's events, as [Crossfader] wants them. */
internal class CrossfadeEvents(private val fader: Crossfader) : Player.Listener {
    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) = fader.onItemChanged()

    override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
        if (reason == Player.DISCONTINUITY_REASON_SEEK || reason == Player.DISCONTINUITY_REASON_SEEK_ADJUSTMENT) {
            fader.onSeek(nearStart = newPosition.positionMs < NEAR_START_MS)
        }
    }

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        if (playWhenReady) fader.onResumed() else fader.onHalted()
    }

    /** A call or another app's audio holds it back (transient loss of audio focus). */
    override fun onPlaybackSuppressionReasonChanged(playbackSuppressionReason: Int) {
        if (playbackSuppressionReason == Player.PLAYBACK_SUPPRESSION_REASON_NONE) fader.onResumed() else fader.onHalted()
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
        when (playbackState) {
            Player.STATE_IDLE, Player.STATE_ENDED -> fader.onHalted()
            Player.STATE_BUFFERING -> fader.onBuffering()
            Player.STATE_READY -> fader.onReady()
        }
    }

    override fun onTimelineChanged(timeline: Timeline, reason: Int) {
        if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) fader.onQueueChanged() else fader.onDurationKnown()
    }

    override fun onRepeatModeChanged(repeatMode: Int) = fader.onOrderChanged()

    override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) = fader.onOrderChanged()

    private companion object {
        const val NEAR_START_MS = 1_000L
    }
}
