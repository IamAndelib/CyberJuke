package io.github.iamandelib.cyberjuke.player

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import io.github.iamandelib.cyberjuke.MainActivity
import java.util.concurrent.atomic.AtomicLong

/**
 * Foreground media service: ExoPlayer + MediaSession. The default Media3 notification
 * provider gives the media notification, lock screen controls and headset buttons.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {

    private var player: ExoPlayer? = null
    private var mediaSession: MediaSession? = null

    /** Failures in a row without reaching STATE_READY; guards against endless skip loops. */
    private var consecutiveFailures = 0

    /** mediaIds already retried once after an HTTP 403/410 (expired stream URL). */
    private val expiredRetried = HashSet<String>()

    override fun onCreate() {
        super.onCreate()

        // DefaultDataSource handles asset:// (CI test tone) and delegates http(s) to OkHttp.
        val upstream = DefaultDataSource.Factory(this, OkHttpDataSource.Factory(Http.client))
        val dataSourceFactory = ResolvingDataSource.Factory(upstream, YtDataSpecResolver)
        val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory)
            .setLoadErrorHandlingPolicy(JukeLoadErrorPolicy())

        val audioAttributes = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()

        val exo = ExoPlayer.Builder(this)
            .setMediaSourceFactory(mediaSourceFactory)
            .setAudioAttributes(audioAttributes, /* handleAudioFocus = */ true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        exo.addListener(PlayerListener())
        player = exo

        val openApp = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val sessionActivity = PendingIntent.getActivity(
            this,
            0,
            openApp,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        mediaSession = MediaSession.Builder(this, exo)
            .setSessionActivity(sessionActivity)
            .setCallback(SessionCallback())
            .build()

        setMediaNotificationProvider(DefaultMediaNotificationProvider.Builder(this).build())
        Log.i(TAG, "PlaybackService created")
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
        mediaSession

    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0 ||
            p.playbackState == Player.STATE_ENDED || p.playbackState == Player.STATE_IDLE
        ) {
            Log.i(TAG, "Task removed while not playing: stopping service")
            pauseAllPlayersAndStopSelf()
        }
    }

    override fun onDestroy() {
        Log.i(TAG, "PlaybackService destroyed")
        mediaSession?.let { session ->
            session.player.release()
            session.release()
        }
        mediaSession = null
        player = null
        super.onDestroy()
    }

    // ---------------------------------------------------------------------------------------

    private inner class PlayerListener : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            if (playbackState == Player.STATE_READY) {
                consecutiveFailures = 0
            }
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            val p = player ?: return
            Log.i(TAG, "Transition to ${mediaItem?.mediaId} (${JukeUris.ytIdOf(mediaItem)}), reason=$reason")
            val next = p.nextMediaItemIndex
            if (next != C.INDEX_UNSET) {
                JukeUris.ytIdOf(p.getMediaItemAt(next))?.let { StreamResolver.prefetch(it) }
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            val p = player ?: return
            handlePlayerError(p, error)
        }
    }

    private fun handlePlayerError(p: ExoPlayer, error: PlaybackException) {
        val index = failedItemIndex(p, error)
        if (index == C.INDEX_UNSET || index >= p.mediaItemCount) {
            Log.e(TAG, "Player error without a current item: ${error.errorCodeName}", error)
            return
        }
        val item = p.getMediaItemAt(index)
        val trackId = item.mediaId
        val ytId = JukeUris.ytIdOf(item)

        // 1. Only an adaptive manifest exists: swap in the manifest URL and retry.
        error.findCause<ManifestOnlyException>()?.let { m ->
            if (item.localConfiguration?.uri?.scheme == JukeUris.SCHEME) {
                Log.w(TAG, "Falling back to manifest for $trackId: ${m.mimeType}")
                val replacement = item.buildUpon()
                    .setUri(Uri.parse(m.manifestUrl))
                    .setMimeType(m.mimeType)
                    .build()
                p.replaceMediaItem(index, replacement)
                p.prepare()
                return
            }
        }

        // 2. Expired / rejected stream URL: re-resolve once.
        val http = error.findCause<HttpDataSource.InvalidResponseCodeException>()
        if (http != null && (http.responseCode == 403 || http.responseCode == 410) &&
            ytId != null && expiredRetried.add(trackId)
        ) {
            Log.w(TAG, "HTTP ${http.responseCode} for $trackId: re-resolving once")
            StreamResolver.invalidate(ytId)
            p.prepare()
            return
        }

        // 3. Give up on this item and continue with the rest of the queue.
        val message = error.findCause<ResolveException>()?.message
            ?: http?.let { "HTTP ${it.responseCode}: ${error.errorCodeName}" }
            ?: "${error.errorCodeName}: ${error.message ?: error.cause?.message ?: "unknown error"}"
        consecutiveFailures++
        Log.e(TAG, "TRACK_ERROR $trackId (yt=$ytId), failure #$consecutiveFailures: $message", error)
        expiredRetried.remove(trackId)

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            Log.e(TAG, "Stopping after $consecutiveFailures consecutive failures")
            consecutiveFailures = 0
            PlayerBus.emitTrackError(
                trackId,
                "Stopped after $MAX_CONSECUTIVE_FAILURES tracks failed in a row. Last error: $message",
                false,
            )
            p.pause()
            return
        }

        if (index == p.currentMediaItemIndex) {
            // Normal case (ExoPlayer reports load errors for the playing item): skip it and
            // keep the list unchanged, so indices on the web side stay valid.
            if (p.hasNextMediaItem()) {
                p.seekToNextMediaItem()
                p.prepare()
                PlayerBus.emitTrackError(trackId, message, true)
            } else {
                // Nothing after it: stay on the failed item, paused. play() retries it.
                p.pause()
                PlayerBus.emitTrackError(trackId, message, false)
            }
        } else {
            // A different (upcoming) item failed: drop it, otherwise re-preparing would hit
            // the same error again while the current item plays.
            p.removeMediaItem(index)
            p.prepare()
            PlayerBus.emitTrackError(trackId, message, true)
        }
    }

    /** The item whose load failed: may be the next item that was being pre-buffered. */
    private fun failedItemIndex(p: Player, error: PlaybackException): Int {
        val periodUid = (error as? ExoPlaybackException)?.mediaPeriodId?.periodUid
        if (periodUid != null) {
            val timeline = p.currentTimeline
            val periodIndex = timeline.getIndexOfPeriod(periodUid)
            if (periodIndex != C.INDEX_UNSET) {
                return timeline.getPeriod(periodIndex, Timeline.Period()).windowIndex
            }
        }
        return if (p.mediaItemCount == 0) C.INDEX_UNSET else p.currentMediaItemIndex
    }

    // ---------------------------------------------------------------------------------------

    private inner class SessionCallback : MediaSession.Callback {
        /**
         * Controllers may send items without a local configuration (URI); rebuild our
         * custom URI from the metadata extras so they stay playable.
         */
        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<MutableList<MediaItem>> {
            val restored = mediaItems.map { item ->
                if (item.localConfiguration != null) {
                    item
                } else {
                    val ytId = item.mediaMetadata.extras?.getString(JukeUris.EXTRA_YT_ID)
                    if (ytId != null) item.buildUpon().setUri(JukeUris.forYt(ytId)).build() else item
                }
            }.toMutableList()
            return Futures.immediateFuture(restored)
        }
    }

    companion object {
        private const val TAG = "CyberJukeService"
        private const val MAX_CONSECUTIVE_FAILURES = 5
    }
}

private inline fun <reified T : Throwable> Throwable.findCause(): T? {
    var t: Throwable? = this
    var depth = 0
    while (t != null && depth < 16) {
        if (t is T) return t
        t = t.cause
        depth++
    }
    return null
}

/** Maps cyberjuke://yt/<id> to the real googlevideo URL + headers, on the loader thread. */
@OptIn(UnstableApi::class)
internal object YtDataSpecResolver : ResolvingDataSource.Resolver {
    private val requestNumber = AtomicLong()

    override fun resolveDataSpec(dataSpec: DataSpec): DataSpec {
        val ytId = JukeUris.ytIdOf(dataSpec.uri)
        if (ytId == LaunchOptions.CI_TONE) {
            return dataSpec.buildUpon().setUri(Uri.parse(LaunchOptions.CI_TONE_ASSET)).build()
        }
        val url: String
        val headers = HashMap(dataSpec.httpRequestHeaders)
        if (ytId != null) {
            val stream = StreamResolver.resolve(ytId)
            url = stream.url
            headers.putAll(stream.headers)
        } else {
            val raw = dataSpec.uri.toString()
            val host = dataSpec.uri.host ?: ""
            if (!host.endsWith("googlevideo.com") && !host.endsWith("youtube.com")) {
                return dataSpec // not ours (e.g. artwork); leave untouched
            }
            url = raw
            headers.putAll(YtCompat.streamHeaders(raw))
        }

        val isVideoPlayback = Uri.parse(url).path?.startsWith("/videoplayback") == true
        val finalUrl = if (isVideoPlayback && !url.contains("&rn=")) {
            url + "&rn=" + requestNumber.incrementAndGet()
        } else {
            url
        }

        val builder = dataSpec.buildUpon()
            .setUri(Uri.parse(finalUrl))
            .setHttpRequestHeaders(headers)
        if (isVideoPlayback && StreamResolver.USE_POST_BODY) {
            builder.setHttpMethod(DataSpec.HTTP_METHOD_POST)
                .setHttpBody(StreamResolver.POST_BODY)
        }
        return builder.build()
    }
}

/** Don't keep retrying resolutions that can never succeed (unavailable video, bot check...). */
@OptIn(UnstableApi::class)
internal class JukeLoadErrorPolicy : DefaultLoadErrorHandlingPolicy() {
    override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long {
        val e = loadErrorInfo.exception
        if (e.findCause<ManifestOnlyException>() != null) return C.TIME_UNSET
        val resolve = e.findCause<ResolveException>()
        if (resolve != null && resolve.permanent) return C.TIME_UNSET
        return super.getRetryDelayMsFor(loadErrorInfo)
    }
}
