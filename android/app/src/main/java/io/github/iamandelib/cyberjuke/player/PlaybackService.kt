package io.github.iamandelib.cyberjuke.player

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
import androidx.media3.exoplayer.source.ShuffleOrder.DefaultShuffleOrder
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionCommands
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import io.github.iamandelib.cyberjuke.MainActivity
import org.json.JSONArray
import java.util.Random
import java.util.concurrent.atomic.AtomicLong

/**
 * Foreground media service: ExoPlayer + MediaSession. The default Media3 notification
 * provider gives the media notification, lock screen controls and headset buttons.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {

    private var player: ExoPlayer? = null
    private var mediaSession: MediaSession? = null
    private val handler = Handler(Looper.getMainLooper())

    /** Per-video failures in a row without reaching STATE_READY; guards against skip loops. */
    private var consecutiveFailures = 0

    /** mediaIds already re-resolved once after an HTTP 403/410 (expired stream URL). */
    private val expiredRetried = HashSet<String>()

    /** "Add to queue" bookkeeping (pure, shared rule with the web: QueueRulesTest). */
    private lateinit var queue: NativeQueue<MediaItem>

    /** "<current mediaId>><next ytId>" already prefetched, so each pair is warmed once. */
    private var prefetchedKey: String? = null
    private val prefetchCheck = Runnable { checkPrefetch() }

    override fun onCreate() {
        super.onCreate()
        // Before anything touches the network: "Prefer IPv4" applies to extraction and streams.
        NetPrefsStore.load(this)

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
        queue = NativeQueue(ExoQueueHost(exo))
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
        handler.removeCallbacks(prefetchCheck)
        StreamResolver.cancelPrefetch()
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
                player?.currentMediaItem?.mediaId?.let { expiredRetried.remove(it) }
                // Playback works end to end after a back-off ran out: reset the ladder. During
                // a running back-off this may just be a cached URL, which proves nothing.
                if (!NetBlock.isBlocked()) NetBlock.success()
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) = schedulePrefetch()

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int,
        ) = schedulePrefetch()

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            queue.onTransition()
            // A skip makes any pending prefetch for the old "next" stale.
            StreamResolver.cancelPrefetch()
            prefetchedKey = null
            Log.i(TAG, "Transition to ${mediaItem?.mediaId} (${JukeUris.ytIdOf(mediaItem)}), reason=$reason")
            schedulePrefetch()
        }

        override fun onPlayerError(error: PlaybackException) {
            val p = player ?: return
            handlePlayerError(p, error)
        }

        override fun onTimelineChanged(timeline: Timeline, reason: Int) {
            if (reason != Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) return
            queue.onPlaylistChanged()
            schedulePrefetch()
        }

        override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) {
            queue.onShuffleModeChanged(shuffleModeEnabled)
            schedulePrefetch()
        }
    }

    /** [QueueHost] over the service's ExoPlayer. */
    private inner class ExoQueueHost(private val p: ExoPlayer) : QueueHost<MediaItem> {
        override val count: Int get() = p.mediaItemCount
        override val currentIndex: Int get() = if (p.mediaItemCount == 0) -1 else p.currentMediaItemIndex
        override val shuffleEnabled: Boolean get() = p.shuffleModeEnabled

        override fun serialAt(index: Int): Long =
            p.getMediaItemAt(index).mediaMetadata.extras?.getLong(JukeCommands.EXTRA_QUEUE_SERIAL, 0L) ?: 0L

        override fun shuffleOrder(): IntArray? {
            val n = p.mediaItemCount
            val shuffle = p.shuffleOrder
            if (n == 0 || shuffle.length != n) return null
            val order = IntArray(n)
            var i = shuffle.firstIndex
            var k = 0
            while (i != C.INDEX_UNSET && k < n) {
                order[k++] = i
                i = shuffle.getNextIndex(i)
            }
            return if (k == n) order else null
        }

        override fun setShuffleOrder(order: IntArray) {
            p.setShuffleOrder(DefaultShuffleOrder(order, shuffleSeeds.nextLong()))
        }

        override fun moveItem(from: Int, to: Int) = p.moveMediaItem(from, to)

        override fun insertTagged(at: Int?, items: List<MediaItem>, serials: List<Long>) {
            val tagged = items.mapIndexed { k, item ->
                val extras = Bundle(item.mediaMetadata.extras ?: Bundle.EMPTY)
                extras.putLong(JukeCommands.EXTRA_QUEUE_SERIAL, serials[k])
                item.buildUpon()
                    .setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(extras).build())
                    .build()
            }
            if (at == null) p.addMediaItems(tagged) else p.addMediaItems(at, tagged)
        }
    }

    private val shuffleSeeds = Random()

    // ---- prefetch (Y4) ------------------------------------------------------------------------

    /** Re-arms the prefetch check for the current item; nothing runs while paused. */
    private fun schedulePrefetch() {
        handler.removeCallbacks(prefetchCheck)
        val p = player ?: return
        if (!p.isPlaying) return
        handler.postDelayed(prefetchCheck, prefetchDelay(p) + 250L)
    }

    private fun prefetchDelay(p: Player): Long {
        val duration = p.duration.takeIf { it != C.TIME_UNSET } ?: -1L
        val delay = PrefetchPolicy.delayMs(p.currentPosition.coerceAtLeast(0L), duration)
        val speed = p.playbackParameters.speed.takeIf { it > 0f } ?: 1f
        return (delay / speed).toLong()
    }

    private fun checkPrefetch() {
        val p = player ?: return
        if (!p.isPlaying) return
        if (prefetchDelay(p) > 0L) {
            schedulePrefetch()
            return
        }
        val next = p.nextMediaItemIndex
        if (next == C.INDEX_UNSET) return
        val ytId = JukeUris.ytIdOf(p.getMediaItemAt(next)) ?: return
        if (ytId == LaunchOptions.CI_TONE) return
        val key = "${p.currentMediaItem?.mediaId}>$ytId"
        if (key == prefetchedKey) return
        prefetchedKey = key
        StreamResolver.prefetch(ytId)
    }

    // ---- "Add to queue" (play next, FIFO) ----------------------------------------------------

    private fun queueNext(p: ExoPlayer, items: List<MediaItem>) {
        val at = queue.queueNext(items)
        if (p.mediaItemCount > 0) Log.i(TAG, "queueNext: ${items.size} item(s) at $at, ${queue.pendingSerials.size} pending")
    }

    // ---- errors (Y1, Y5) ----------------------------------------------------------------------

    private fun handlePlayerError(p: ExoPlayer, error: PlaybackException) {
        val index = failedItemIndex(p, error)
        if (index == C.INDEX_UNSET || index >= p.mediaItemCount) {
            Log.w(TAG, "Player error without a current item: ${error.errorCodeName}")
            return
        }
        val item = p.getMediaItemAt(index)
        val trackId = item.mediaId
        val ytId = JukeUris.ytIdOf(item)

        // 1. Only an adaptive manifest exists: swap in the manifest URL and retry.
        error.findCause<ManifestOnlyException>()?.let { m ->
            if (item.localConfiguration?.uri?.scheme == JukeUris.SCHEME) {
                Log.i(TAG, "Falling back to manifest for $trackId: ${m.mimeType}")
                val replacement = item.buildUpon()
                    .setUri(Uri.parse(m.manifestUrl))
                    .setMimeType(m.mimeType)
                    .build()
                p.replaceMediaItem(index, replacement)
                p.prepare()
                return
            }
        }

        val http = error.findCause<HttpDataSource.InvalidResponseCodeException>()
        val resolve = error.findCause<ResolveException>()
        val served = ytId?.let { StreamResolver.lastServed(it) }
        val facts = TrackErrorPolicy.Facts(
            kind = resolve?.kind,
            httpCode = http?.responseCode,
            urlAgeMs = served?.let { System.currentTimeMillis() - it.resolvedAtMs },
            alreadyReResolved = trackId in expiredRetried,
            blocked = error.findCause<BlockedException>() != null,
            ioNetwork = error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED ||
                error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
            isCurrent = index == p.currentMediaItemIndex,
            hasNext = p.hasNextMediaItem(),
            consecutiveFailures = consecutiveFailures,
        )
        val message = resolve?.message
            ?: http?.let { "HTTP ${it.responseCode}: ${error.errorCodeName}" }
            ?: "${error.errorCodeName}: ${error.message ?: error.cause?.message ?: "unknown error"}"
        val action = TrackErrorPolicy.decide(facts)
        Log.w(TAG, "Player error ${error.errorCodeName} -> ${action.javaClass.simpleName}")

        when (action) {
            TrackErrorPolicy.Action.WaitBlocked -> {
                // A back-off is running: stay here, paused, without a request. play() after it
                // ends tries once more.
                p.pause()
            }
            is TrackErrorPolicy.Action.Block -> {
                Log.i(TAG, "BLOCKED ${action.reason} on $trackId: $message")
                NetBlock.trip(action.reason)
                StreamResolver.cancelPrefetch()
                p.pause()
            }
            TrackErrorPolicy.Action.ReResolve -> {
                if (ytId == null) {
                    perVideoFailure(p, index, trackId, ytId, message, error)
                    return
                }
                // Expired URL (or a new network address): same itag, same position.
                Log.i(TAG, "HTTP ${http?.responseCode} for $trackId: re-resolving once")
                expiredRetried.add(trackId)
                StreamResolver.reResolve(ytId)
                p.prepare()
            }
            is TrackErrorPolicy.Action.Pause -> {
                Log.i(TAG, "TRACK_ERROR $trackId (yt=$ytId), pausing: $message")
                p.pause()
                PlayerBus.emitTrackError(trackId, message, false)
            }
            else -> perVideoFailure(p, index, trackId, ytId, message, error)
        }
    }

    /** A real per-video failure: skip it (with the [TrackErrorPolicy.MAX_CONSECUTIVE_FAILURES] guard). */
    private fun perVideoFailure(
        p: ExoPlayer,
        index: Int,
        trackId: String,
        ytId: String?,
        message: String,
        error: PlaybackException,
    ) {
        consecutiveFailures++
        // Ids only at info level (stripped from release builds); the warning has none.
        Log.i(TAG, "TRACK_ERROR $trackId (yt=$ytId), failure #$consecutiveFailures: $message")
        Log.w(TAG, "Track failed (#$consecutiveFailures): ${error.errorCodeName}")
        expiredRetried.remove(trackId)

        if (consecutiveFailures >= TrackErrorPolicy.MAX_CONSECUTIVE_FAILURES) {
            Log.w(TAG, "Stopping after $consecutiveFailures consecutive failures")
            consecutiveFailures = 0
            PlayerBus.emitTrackError(
                trackId,
                "Stopped after ${TrackErrorPolicy.MAX_CONSECUTIVE_FAILURES} tracks failed in a row. Last error: $message",
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
         * S1: full access for our own app, the media notification, Android Auto/Automotive and
         * trusted system controllers; transport commands only for everyone else (see
         * [SessionPolicy]). Our own app also gets the queueNext custom command.
         */
        override fun onConnectAsync(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
        ): ListenableFuture<MediaSession.ConnectionResult> {
            val access = accessOf(session, controller)
            Log.i(TAG, "Controller ${controller.packageName} uid=${controller.uid} access=$access")
            val builder = MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
            if (access == SessionPolicy.Access.FULL) {
                if (isOwnApp(controller)) {
                    builder.setAvailableSessionCommands(
                        MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                            .add(JukeCommands.QUEUE_NEXT)
                            .build(),
                    )
                }
            } else {
                // Media3 intersects these with what the player currently offers.
                val commands = Player.Commands.Builder()
                SessionPolicy.TRANSPORT_COMMANDS.forEach { commands.add(it) }
                builder.setAvailablePlayerCommands(commands.build())
                builder.setAvailableSessionCommands(SessionCommands.EMPTY)
            }
            return Futures.immediateFuture(builder.build())
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle,
        ): ListenableFuture<SessionResult> {
            if (customCommand.customAction != JukeCommands.ACTION_QUEUE_NEXT || !isOwnApp(controller)) {
                return super.onCustomCommand(session, controller, customCommand, args)
            }
            val p = player ?: return Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
            val items = try {
                JukeTracks.parse(JSONArray(args.getString(JukeCommands.ARG_TRACKS) ?: "[]"))
            } catch (e: Exception) {
                Log.w(TAG, "queueNext: bad tracks: ${e.javaClass.simpleName}")
                return Futures.immediateFuture(SessionResult(SessionError.ERROR_BAD_VALUE))
            }
            queueNext(p, items)
            return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        }

        /**
         * Items from a controller (also reached through the default onSetMediaItems): the URI is
         * always rebuilt as `cyberjuke://yt/<id>` from a valid 11-character ytId (from our URI
         * or the metadata extra), never taken from the controller, so no controller can make us
         * fetch an arbitrary URL or read a local file. Artwork only from https://i.ytimg.com.
         * Items without a valid id are dropped.
         */
        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<MutableList<MediaItem>> {
            val ciTone = if (isOwnApp(controller) && isDebuggable()) LaunchOptions.CI_TONE else null
            val restored = mediaItems.mapNotNull { item -> sanitize(item, ciTone) }.toMutableList()
            if (restored.size != mediaItems.size) {
                Log.w(TAG, "Dropped ${mediaItems.size - restored.size} item(s) without a valid id")
            }
            return Futures.immediateFuture(restored)
        }
    }

    private fun sanitize(item: MediaItem, extraAllowed: String?): MediaItem? {
        val ytId = SessionPolicy.ytIdForIncoming(
            JukeUris.ytIdOf(item.localConfiguration?.uri),
            item.mediaMetadata.extras?.getString(JukeUris.EXTRA_YT_ID),
            extraAllowed,
        ) ?: return null
        val artwork = item.mediaMetadata.artworkUri?.toString()?.takeIf { SessionPolicy.isAllowedArtwork(it) }
        val extras = Bundle().apply { putString(JukeUris.EXTRA_YT_ID, ytId) }
        val metadata = item.mediaMetadata.buildUpon()
            .setArtworkUri(artwork?.let { Uri.parse(it) })
            .setArtworkData(null, null)
            .setExtras(extras)
            .build()
        return MediaItem.Builder()
            .setMediaId(item.mediaId)
            .setUri(JukeUris.forYt(ytId))
            .setMediaMetadata(metadata)
            .build()
    }

    private fun isOwnApp(controller: MediaSession.ControllerInfo): Boolean =
        controller.isTrusted && controller.packageName == packageName

    private fun accessOf(session: MediaSession, controller: MediaSession.ControllerInfo): SessionPolicy.Access =
        SessionPolicy.access(
            SessionPolicy.Controller(
                packageName = controller.packageName,
                uid = controller.uid,
                isTrusted = controller.isTrusted,
                isMediaNotificationController = session.isMediaNotificationController(controller),
                isAutoCompanionController = session.isAutoCompanionController(controller),
                isAutomotiveController = session.isAutomotiveController(controller),
            ),
            packageName,
        )

    companion object {
        private const val TAG = "CyberJukeService"
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
            // A load that starts past byte 0 resumes a track: keep its itag (same file).
            val stream = StreamResolver.resolve(ytId, midStream = dataSpec.position > 0)
            url = stream.url
            headers.putAll(stream.headers)
        } else {
            val raw = dataSpec.uri.toString()
            if (!Hosts.isYouTubeMedia(dataSpec.uri.host)) {
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

/**
 * Don't keep retrying what can never succeed or would make things worse: unavailable videos,
 * bot checks, a running back-off, and HTTP 403/410/429 (429 must never be retried; 403/410 are
 * handled by re-resolving in PlaybackService). Network failures keep ExoPlayer's retries.
 */
@OptIn(UnstableApi::class)
internal class JukeLoadErrorPolicy : DefaultLoadErrorHandlingPolicy() {
    override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long {
        val e = loadErrorInfo.exception
        if (e.findCause<ManifestOnlyException>() != null) return C.TIME_UNSET
        if (e.findCause<BlockedException>() != null) return C.TIME_UNSET
        val resolve = e.findCause<ResolveException>()
        if (resolve != null && resolve.permanent) return C.TIME_UNSET
        val http = e.findCause<HttpDataSource.InvalidResponseCodeException>()
        if (http != null && http.responseCode in NO_RETRY_HTTP) return C.TIME_UNSET
        return super.getRetryDelayMsFor(loadErrorInfo)
    }

    private companion object {
        val NO_RETRY_HTTP = setOf(403, 410, 429)
    }
}
