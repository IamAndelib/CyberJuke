package io.github.iamandelib.cyberjuke.player

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Bundle
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

    /** Failures in a row without reaching STATE_READY; guards against endless skip loops. */
    private var consecutiveFailures = 0

    /** mediaIds already retried once after an HTTP 403/410 (expired stream URL). */
    private val expiredRetried = HashSet<String>()

    /**
     * User-queued items ("Add to queue") that have not started playing yet, as serials
     * ([JukeCommands.EXTRA_QUEUE_SERIAL] in the item's metadata extras) in FIFO order. A serial
     * rather than the mediaId, so the same track queued twice stays two entries. An entry is
     * dropped once its item becomes current (it has played) or leaves the playlist (removed,
     * or the whole queue replaced by setQueue).
     */
    private val userQueued = LinkedHashSet<Long>()
    private var nextQueueSerial = 1L
    private val shuffleSeeds = Random()

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
            pruneUserQueued(p)
            enforceShuffleOrder(p)
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

        override fun onTimelineChanged(timeline: Timeline, reason: Int) {
            if (reason != Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) return
            val p = player ?: return
            pruneUserQueued(p)
            // Additions by the web side re-randomise the shuffle order around our items; put
            // the user-queued ones back next. Idempotent, so our own setShuffleOrder (which
            // also lands here) ends the loop.
            enforceShuffleOrder(p)
        }

        override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) {
            val p = player ?: return
            pruneUserQueued(p)
            // Toggling keeps user-queued tracks next in both directions.
            if (shuffleModeEnabled) enforceShuffleOrder(p) else enforceLinearOrder(p)
        }
    }

    // ---- "Add to queue" (play next, FIFO) ----------------------------------------------------

    private fun serialOf(item: MediaItem): Long =
        item.mediaMetadata.extras?.getLong(JukeCommands.EXTRA_QUEUE_SERIAL, 0L) ?: 0L

    /** Playlist indices of pending user-queued items, FIFO, excluding the current item. */
    private fun userQueuedIndices(p: Player): List<Int> {
        if (userQueued.isEmpty()) return emptyList()
        val bySerial = HashMap<Long, Int>()
        for (i in 0 until p.mediaItemCount) {
            val s = serialOf(p.getMediaItemAt(i))
            if (s != 0L) bySerial[s] = i
        }
        val current = p.currentMediaItemIndex
        return userQueued.mapNotNull { bySerial[it] }.filter { it != current }
    }

    /** Drops entries that have played (now current) or are no longer in the playlist. */
    private fun pruneUserQueued(p: Player) {
        if (userQueued.isEmpty()) return
        val present = HashSet<Long>()
        for (i in 0 until p.mediaItemCount) present.add(serialOf(p.getMediaItemAt(i)))
        if (p.mediaItemCount > 0) present.remove(serialOf(p.getMediaItemAt(p.currentMediaItemIndex)))
        userQueued.retainAll(present)
    }

    /**
     * Inserts [items] after the current item and after earlier user-queued items, so they play
     * in the order they were added, then the original queue continues.
     */
    private fun queueNext(p: ExoPlayer, items: List<MediaItem>) {
        if (items.isEmpty()) return
        pruneUserQueued(p)
        val tagged = items.map { item ->
            val serial = nextQueueSerial++
            val extras = Bundle(item.mediaMetadata.extras ?: Bundle.EMPTY)
            extras.putLong(JukeCommands.EXTRA_QUEUE_SERIAL, serial)
            serial to item.buildUpon()
                .setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(extras).build())
                .build()
        }
        if (p.mediaItemCount == 0) {
            p.addMediaItems(tagged.map { it.second })
            userQueued.addAll(tagged.map { it.first })
            pruneUserQueued(p)
            return
        }
        // Linear order: earlier queued items sit right after the current one (FIFO), so the
        // new ones go after that block. With shuffle on the playlist position only matters
        // once shuffle is turned off again; the shuffle order is fixed up below.
        if (!p.shuffleModeEnabled) enforceLinearOrder(p)
        val current = p.currentMediaItemIndex
        var at = current + 1
        while (at < p.mediaItemCount && serialOf(p.getMediaItemAt(at)) in userQueued) at++
        p.addMediaItems(at, tagged.map { it.second })
        userQueued.addAll(tagged.map { it.first })
        enforceShuffleOrder(p)
        Log.i(TAG, "queueNext: ${items.size} item(s) at $at, ${userQueued.size} pending")
    }

    /** Shuffle on: a shuffle order with the pending user-queued items right after current. */
    private fun enforceShuffleOrder(p: ExoPlayer) {
        if (!p.shuffleModeEnabled || userQueued.isEmpty()) return
        val n = p.mediaItemCount
        val shuffle = p.shuffleOrder
        if (n == 0 || shuffle.length != n) return
        val order = IntArray(n)
        var i = shuffle.firstIndex
        var k = 0
        while (i != C.INDEX_UNSET && k < n) {
            order[k++] = i
            i = shuffle.getNextIndex(i)
        }
        if (k != n) return
        val desired = QueueOrder.placeNext(order, p.currentMediaItemIndex, userQueuedIndices(p))
        if (!desired.contentEquals(order)) {
            p.setShuffleOrder(DefaultShuffleOrder(desired, shuffleSeeds.nextLong()))
        }
    }

    /** Shuffle off: moves the pending user-queued items right after the current item. */
    private fun enforceLinearOrder(p: ExoPlayer) {
        if (p.shuffleModeEnabled || userQueued.isEmpty()) return
        val n = p.mediaItemCount
        if (n == 0) return
        val linear = IntArray(n) { it }
        val desired = QueueOrder.placeNext(linear, p.currentMediaItemIndex, userQueuedIndices(p))
        for ((from, to) in QueueOrder.moves(desired)) p.moveMediaItem(from, to)
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
        /** Same defaults as Media3, plus our custom commands for this app's own controller. */
        override fun onConnectAsync(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
        ): ListenableFuture<MediaSession.ConnectionResult> {
            val builder = MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
            if (controller.isTrusted && controller.packageName == packageName) {
                builder.setAvailableSessionCommands(
                    MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                        .add(JukeCommands.QUEUE_NEXT)
                        .build(),
                )
            }
            return Futures.immediateFuture(builder.build())
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle,
        ): ListenableFuture<SessionResult> {
            if (customCommand.customAction != JukeCommands.ACTION_QUEUE_NEXT) {
                return super.onCustomCommand(session, controller, customCommand, args)
            }
            val p = player ?: return Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
            val items = try {
                JukeTracks.parse(JSONArray(args.getString(JukeCommands.ARG_TRACKS) ?: "[]"))
            } catch (e: Exception) {
                Log.w(TAG, "queueNext: bad tracks: ${e.message}")
                return Futures.immediateFuture(SessionResult(SessionError.ERROR_BAD_VALUE))
            }
            queueNext(p, items)
            return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        }

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
