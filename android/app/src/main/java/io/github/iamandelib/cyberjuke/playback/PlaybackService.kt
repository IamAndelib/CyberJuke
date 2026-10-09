package io.github.iamandelib.cyberjuke.playback

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.Uri
import android.os.Bundle
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
import io.github.iamandelib.cyberjuke.net.BlockedException
import io.github.iamandelib.cyberjuke.net.FailureKind
import io.github.iamandelib.cyberjuke.net.Hosts
import io.github.iamandelib.cyberjuke.net.Http
import io.github.iamandelib.cyberjuke.net.NetBlock
import io.github.iamandelib.cyberjuke.net.NetEpoch
import io.github.iamandelib.cyberjuke.yt.Radio
import io.github.iamandelib.cyberjuke.yt.YtCompat
import io.github.iamandelib.cyberjuke.yt.YtMusic
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.Random
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
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

    // ---- autoplay (AP1, AP4) ----
    /** The Autoplay setting (C3), sent by the web side at start. */
    private var autoplayEnabled = true

    /** The track autoplay follows; null until a list is set through SET_LIST. */
    private var seedId: String? = null
    private var context: Pair<String, String>? = null

    /** A Global seed's YouTube Music radio: refilled here, so it works with the screen off. */
    private data class RadioState(val ytId: String, val next: String?)

    private var radio: RadioState? = null

    /** Bumped when the seed or list changes: a radio page fetched for the old one is dropped. */
    private var radioGen = 0
    private var radioInFlight = false

    /** Retries since the radio last added items (an empty or failed page, L5); bounded. */
    private var radioRetries = 0

    /** No radio request before this (SystemClock.elapsedRealtime), after a failed page. */
    private var radioNotBefore = 0L

    /** What the last "low" check acted on, so each low state is handled once. */
    private var lowKey: String? = null
    private val lowCheck = Runnable { checkLow() }
    private val radioExecutor: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "JukeRadio").apply { isDaemon = true }
    }

    /** "<current mediaId>><next ytId>" already prefetched, so each pair is warmed once. */
    private var prefetchedKey: String? = null
    private val prefetchCheck = Runnable { checkPrefetch() }

    /**
     * H1: googlevideo URLs are bound to the IP that resolved them. On a new default network
     * (or new addresses on it) the cached URLs go, and a 403 on a URL from before the change
     * re-resolves instead of counting as STREAM_FORBIDDEN (TrackErrorPolicy, [NetEpoch]).
     */
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            if (NetEpoch.onNetwork(network.toString())) onNetworkChanged()
        }

        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            val addresses = linkProperties.linkAddresses.mapNotNull { it.address?.hostAddress }.toSet()
            if (NetEpoch.onAddresses(network.toString(), addresses)) onNetworkChanged()
        }
    }
    private var networkCallbackRegistered = false

    /** Any thread (ConnectivityManager's). */
    private fun onNetworkChanged() {
        StreamResolver.clear()
        try {
            Http.client.connectionPool.evictAll()
        } catch (_: Exception) {
        }
        Log.i(TAG, "Default network changed (generation ${NetEpoch.generation}): stream URLs dropped")
    }

    override fun onCreate() {
        super.onCreate()
        // Before anything touches the network: "Prefer IPv4" applies to extraction and streams.
        NetPrefsStore.load(this)
        YtDataSpecResolver.allowCiTone = isDebuggable()
        try {
            (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager)
                .registerDefaultNetworkCallback(networkCallback)
            networkCallbackRegistered = true
        } catch (e: Exception) { // SecurityException without ACCESS_NETWORK_STATE, or too many callbacks
            Log.w(TAG, "No network callback: ${e.javaClass.simpleName}")
        }

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
        handler.removeCallbacks(lowCheck)
        radioExecutor.shutdownNow()
        StreamResolver.cancelPrefetch()
        if (networkCallbackRegistered) {
            try {
                (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager)
                    .unregisterNetworkCallback(networkCallback)
            } catch (_: Exception) {
            }
            networkCallbackRegistered = false
        }
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
                // No NetBlock.success() here: READY from a cached URL or buffered bytes proves
                // nothing about YouTube; a successful extraction or InnerTube request does (M1).
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
            val trimmed = queue.trimPlayedAuto(QueueCommands.KEEP_PLAYED_AUTO)
            if (trimmed > 0) Log.i(TAG, "Trimmed $trimmed played autoplay item(s)")
            queueChanged()
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
            queueChanged()
            schedulePrefetch()
        }

        override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) {
            queue.onShuffleModeChanged(shuffleModeEnabled)
            queueChanged()
            schedulePrefetch()
        }

        /** Repeat all or one turns autoplay off; back to off, autoplay fills up again. */
        override fun onRepeatModeChanged(repeatMode: Int) {
            queue.onRepeatModeChanged(repeatMode != Player.REPEAT_MODE_OFF)
            lowKey = null
            queueChanged()
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
            val tagged = items.mapIndexed { k, item -> tag(item) { putLong(JukeCommands.EXTRA_QUEUE_SERIAL, serials[k]) } }
            if (at == null) p.addMediaItems(tagged) else p.addMediaItems(at, tagged)
        }

        override fun itemAt(index: Int): MediaItem = p.getMediaItemAt(index)

        override fun idAt(index: Int): String = p.getMediaItemAt(index).mediaId

        override fun isAutoAt(index: Int): Boolean =
            p.getMediaItemAt(index).mediaMetadata.extras?.getBoolean(QueueCommands.EXTRA_AUTOPLAY, false) == true

        override fun setItems(items: List<MediaItem>, serials: List<Long>, start: Int, positionMs: Long) {
            if (items.isEmpty()) {
                p.clearMediaItems()
                return
            }
            val tagged = items.mapIndexed { k, item ->
                if (serials[k] == 0L) item else tag(item) { putLong(JukeCommands.EXTRA_QUEUE_SERIAL, serials[k]) }
            }
            p.setMediaItems(tagged, start, positionMs.coerceAtLeast(0L))
        }

        override fun insertAuto(at: Int?, items: List<MediaItem>) {
            val tagged = items.map { tag(it) { putBoolean(QueueCommands.EXTRA_AUTOPLAY, true) } }
            if (at == null) p.addMediaItems(tagged) else p.addMediaItems(at, tagged)
        }

        override fun removeAt(index: Int) = p.removeMediaItem(index)

        override fun seekTo(index: Int) = p.seekTo(index, 0L)

        private inline fun tag(item: MediaItem, edit: Bundle.() -> Unit): MediaItem {
            val extras = Bundle(item.mediaMetadata.extras ?: Bundle.EMPTY).apply(edit)
            return item.buildUpon()
                .setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(extras).build())
                .build()
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
        queueChanged()
    }

    // ---- lists and autoplay (P1, AP1, AP4) ---------------------------------------------------

    /** A new list (queued items stay next); autoplay starts over from the started track. */
    private fun setList(items: List<MediaItem>, start: Int, positionMs: Long, label: String, mode: String) {
        queue.setList(items, start, positionMs)
        // A new list starts the failure count over (the old list's failures say nothing here).
        resetFailures()
        // An empty list clears everything: no context, no seed, no radio (L4).
        context = if (items.isEmpty()) null else label to mode
        val seed = items.getOrNull(start.coerceIn(0, (items.size - 1).coerceAtLeast(0)))
        reseed(seed)
        Log.i(TAG, "setList: ${items.size} item(s), mode=$mode, ${queue.pendingSerials.size} queued kept")
    }

    /** Autoplay follows [seed] from now on: a Global seed gets its radio from here. */
    private fun reseed(seed: MediaItem?) {
        seedId = seed?.mediaId
        radioGen++
        radioInFlight = false
        radioRetries = 0
        radioNotBefore = 0L
        lowKey = null
        val ytId = seed?.takeIf { it.mediaId.startsWith(QueueCommands.GLOBAL_PREFIX) }?.let { JukeUris.ytIdOf(it) }
        radio = ytId?.let { RadioState(it, null) }
        queueChanged()
    }

    private fun addAutoplay(items: List<MediaItem>, forSeed: String?) {
        if (!autoplayEnabled || forSeed != seedId || player?.repeatMode != Player.REPEAT_MODE_OFF) {
            Log.i(TAG, "addAutoplay: ${items.size} item(s) dropped (stale or autoplay off)")
            return
        }
        queue.addAutoplay(items)
        Log.i(TAG, "addAutoplay: ${items.size} item(s), ${queue.autoAhead()} ahead")
        queueChanged()
    }

    private fun setAutoplay(enabled: Boolean) {
        if (enabled == autoplayEnabled) return
        autoplayEnabled = enabled
        lowKey = null
        if (!enabled) {
            radioGen++
            radioInFlight = false
            queue.dropUpcomingAuto()
        }
        queueChanged()
    }

    /** A tap in Up next: on an autoplay item the radio continues from it. */
    private fun skipTo(p: ExoPlayer, index: Int) {
        resetFailures()
        if (queue.skipTo(index)) reseed(p.currentMediaItem) else queueChanged()
    }

    private fun resetFailures() {
        consecutiveFailures = 0
        expiredRetried.clear()
    }

    /** Sign-out (K5): every item with one of [ids] goes; with nothing left to play, pause. */
    private fun removeIds(p: ExoPlayer, ids: Set<String>) {
        val r = queue.removeIds(ids)
        Log.i(TAG, "removeIds: ${r.removed} item(s) removed, stopped=${r.stopped}")
        if (r.stopped) p.pause()
        if (p.mediaItemCount == 0) {
            context = null
            reseed(null)
        } else {
            queueChanged()
        }
    }

    private fun restore(item: MediaItem, section: NativeQueue.Section, beforeId: String?) {
        if (section == NativeQueue.Section.AUTO &&
            (!autoplayEnabled || player?.repeatMode != Player.REPEAT_MODE_OFF)
        ) {
            Log.i(TAG, "restore: autoplay item dropped (autoplay off or repeat on)")
            return
        }
        queue.restore(item, section, beforeId)
        queueChanged()
    }

    /** Publishes the queue facts for the plugin's state and checks autoplay (posted, once). */
    private fun queueChanged() {
        QueueInfo.pendingSerials = queue.pendingSerials.toSet()
        QueueInfo.context = context
        QueueInfo.seedId = seedId
        handler.removeCallbacks(lowCheck)
        handler.post(lowCheck)
    }

    /**
     * AP4: with 5 autoplay items or fewer to go, get more. A Global radio is refilled here;
     * Jukebox picks come from the web side (`queueLow`). Nothing with autoplay off or repeat on.
     */
    private fun checkLow() {
        val p = player ?: return
        if (!autoplayEnabled || p.repeatMode != Player.REPEAT_MODE_OFF || p.mediaItemCount == 0 || seedId == null) {
            lowKey = null
            return
        }
        val left = queue.autoAhead()
        if (left > QueueCommands.LOW) {
            lowKey = null
            return
        }
        val key = "$seedId|$left|${p.currentMediaItemIndex}|${p.mediaItemCount}"
        if (key == lowKey) return
        lowKey = key
        val r = radio
        if (r != null) refillRadio(r) else QueueInfo.emitQueueLow(left, seedId)
    }

    /** One radio page at a time, never during a back-off (Y1); a bot check or 429 starts one. */
    private fun refillRadio(r: RadioState) {
        if (radioInFlight) return
        val wait = maxOf(
            NetBlock.active().first - System.currentTimeMillis(),
            radioNotBefore - SystemClock.elapsedRealtime(),
        )
        if (wait > 0) {
            // Try again once the back-off (or the retry delay) is over, even with no event.
            lowKey = null
            if (radioRetries < RADIO_MAX_RETRIES) {
                handler.removeCallbacks(lowCheck)
                handler.postDelayed(lowCheck, wait + 1000L)
            }
            return
        }
        radioInFlight = true
        val gen = radioGen
        try {
            radioExecutor.execute {
                val result = runCatching { YtMusic.radio(r.ytId, r.next) }
                handler.post { onRadioPage(gen, r, result) }
            }
        } catch (_: Exception) { // RejectedExecutionException after onDestroy
            radioInFlight = false
        }
    }

    private fun onRadioPage(gen: Int, r: RadioState, result: Result<Radio.Page>) {
        if (gen != radioGen) return
        radioInFlight = false
        val p = player ?: return
        result.onFailure { t ->
            val kind = YtCompat.classify(t)
            Log.w(TAG, "Radio failed [$kind]: ${t.javaClass.simpleName}")
            kind.blockReason?.let { NetBlock.trip(it) }
            if (kind == FailureKind.BROKEN) PlayerBus.emitExtractorBroken(YtCompat.describe(t))
            // L5: a failed page must not stall the radio; retry later (bounded).
            retryRadio(delayMs = RADIO_RETRY_MS * (radioRetries + 1))
        }
        val page = result.getOrNull() ?: return
        val have = HashSet<String>()
        for (i in 0 until p.mediaItemCount) JukeUris.ytIdOf(p.getMediaItemAt(i))?.let { have.add(it) }
        val items = page.items.mapNotNull { it ->
            val ytId = it.ytId ?: return@mapNotNull null
            if (!have.add(ytId)) return@mapNotNull null
            runCatching {
                JukeTracks.toMediaItem(
                    JSONObject()
                        .put("id", QueueCommands.GLOBAL_PREFIX + ytId)
                        .put("ytId", ytId)
                        .put("title", it.title)
                        .put("artist", Radio.cleanCredit(it.subtitle))
                        .put("artworkUrl", "https://i.ytimg.com/vi/$ytId/hqdefault.jpg"),
                )
            }.getOrNull()
        }
        // At the end of a radio, start a new one from its last song.
        radio = when {
            page.next != null -> r.copy(next = page.next)
            items.isNotEmpty() -> JukeUris.ytIdOf(items.last())?.let { RadioState(it, null) }
            else -> null
        }
        Log.i(TAG, "Radio: ${items.size} new of ${page.items.size}, more=${page.next != null}")
        if (items.isNotEmpty() && autoplayEnabled && p.repeatMode == Player.REPEAT_MODE_OFF) {
            radioRetries = 0
            queue.addAutoplay(items)
            queueChanged()
        } else if (items.isEmpty() && radio != null) {
            // L5: nothing new on this page (all duplicates) but the radio goes on: the next page.
            retryRadio(delayMs = 0L)
        }
    }

    /** Checks the low state again after [delayMs], at most [RADIO_MAX_RETRIES] times in a row. */
    private fun retryRadio(delayMs: Long) {
        if (radioRetries >= RADIO_MAX_RETRIES) {
            Log.w(TAG, "Radio: giving up after $radioRetries retries")
            return
        }
        radioRetries++
        radioNotBefore = SystemClock.elapsedRealtime() + delayMs
        lowKey = null
        handler.removeCallbacks(lowCheck)
        handler.postDelayed(lowCheck, delayMs)
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
        val now = System.currentTimeMillis()
        val facts = TrackErrorPolicy.Facts(
            kind = resolve?.kind,
            httpCode = http?.responseCode,
            urlAgeMs = served?.let { now - it.resolvedAtMs },
            urlExpired = served?.let { StreamUrls.isExpired(it.url, it.resolvedAtMs, now) } == true,
            resolvedBeforeNetworkChange = served?.let { it.netGen < NetEpoch.generation } == true,
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
                // The rejected URL must not be tried again from the cache (L1).
                ytId?.let { StreamResolver.reResolve(it) }
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
                if (item.localConfiguration?.uri?.scheme != JukeUris.SCHEME) {
                    // Swapped to its HLS manifest earlier: that manifest is what expired (L15).
                    // Back to our URI, so the resolver fetches a fresh one.
                    p.replaceMediaItem(index, item.buildUpon().setUri(JukeUris.forYt(ytId)).setMimeType(null).build())
                }
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
         * [SessionPolicy]). Only the JukePlayer plugin's controller gets the private queue
         * commands, and the media notification gets no timeline (no platform queue).
         */
        override fun onConnectAsync(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
        ): ListenableFuture<MediaSession.ConnectionResult> {
            val info = infoOf(session, controller)
            val access = SessionPolicy.access(info, packageName)
            val grant = SessionPolicy.grant(info, packageName, ControllerKey.token)
            Log.i(TAG, "Controller ${controller.packageName} uid=${controller.uid} access=$access grant=$grant")
            val builder = MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
            when (grant) {
                SessionPolicy.Grant.PLUGIN -> builder.setAvailableSessionCommands(
                    MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                        .add(JukeCommands.QUEUE_NEXT)
                        .apply { QueueCommands.ALL.forEach { add(it) } }
                        .build(),
                )
                SessionPolicy.Grant.FULL -> Unit
                SessionPolicy.Grant.NOTIFICATION -> {
                    val commands = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
                    SessionPolicy.NOTIFICATION_HIDDEN_COMMANDS.forEach { commands.remove(it) }
                    builder.setAvailablePlayerCommands(commands.build())
                    builder.setAvailableSessionCommands(MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS)
                }
                SessionPolicy.Grant.TRANSPORT -> {
                    // Media3 intersects these with what the player currently offers.
                    val commands = Player.Commands.Builder()
                    SessionPolicy.TRANSPORT_COMMANDS.forEach { commands.add(it) }
                    builder.setAvailablePlayerCommands(commands.build())
                    builder.setAvailableSessionCommands(SessionCommands.EMPTY)
                }
            }
            return Futures.immediateFuture(builder.build())
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle,
        ): ListenableFuture<SessionResult> {
            val action = customCommand.customAction
            val ours = action == JukeCommands.ACTION_QUEUE_NEXT || QueueCommands.ALL.any { it.customAction == action }
            if (!ours || !isPlugin(session, controller)) {
                return super.onCustomCommand(session, controller, customCommand, args)
            }
            val p = player ?: return Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
            fun tracks(): List<MediaItem>? = try {
                JukeTracks.parse(JSONArray(args.getString(JukeCommands.ARG_TRACKS) ?: "[]"))
            } catch (e: TooLargeException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "$action: bad tracks: ${e.javaClass.simpleName}")
                null
            }
            val bad = Futures.immediateFuture(SessionResult(SessionError.ERROR_BAD_VALUE))
            val stale = failure(QueueCommands.STALE_INDEX)
            /** The item at [index] is the one the caller saw ([QueueCommands.ARG_EXPECT], K2). */
            fun matches(index: Int): Boolean {
                val expect = args.getString(QueueCommands.ARG_EXPECT) ?: return true
                return p.getMediaItemAt(index).mediaId == expect
            }
            try {
                when (action) {
                    JukeCommands.ACTION_QUEUE_NEXT -> queueNext(p, tracks() ?: return bad)
                    QueueCommands.ACTION_SET_LIST -> setList(
                        tracks() ?: return bad,
                        args.getInt(QueueCommands.ARG_START, 0),
                        args.getLong(QueueCommands.ARG_POSITION, 0L),
                        BridgeLimits.checkString(args.getString(QueueCommands.ARG_LABEL), "label") ?: "",
                        if (args.getString(QueueCommands.ARG_MODE) == "radio") "radio" else "list",
                    )
                    QueueCommands.ACTION_ADD_AUTOPLAY -> addAutoplay(
                        tracks() ?: return bad,
                        BridgeLimits.checkString(args.getString(QueueCommands.ARG_SEED), "seedId"),
                    )
                    QueueCommands.ACTION_SET_AUTOPLAY -> setAutoplay(args.getBoolean(QueueCommands.ARG_ENABLED, true))
                    QueueCommands.ACTION_SKIP_TO -> {
                        val index = args.getInt(QueueCommands.ARG_INDEX, -1)
                        if (index !in 0 until p.mediaItemCount) return bad
                        if (!matches(index)) return stale
                        skipTo(p, index)
                    }
                    QueueCommands.ACTION_REMOVE -> {
                        val index = args.getInt(QueueCommands.ARG_INDEX, -1)
                        if (index !in 0 until p.mediaItemCount) return bad
                        if (!matches(index)) return stale
                        p.removeMediaItem(index)
                    }
                    QueueCommands.ACTION_MOVE -> {
                        val from = args.getInt(QueueCommands.ARG_FROM, -1)
                        val to = args.getInt(QueueCommands.ARG_TO, -1)
                        val n = p.mediaItemCount
                        if (from !in 0 until n || to !in 0 until n) return bad
                        if (!matches(from)) return stale
                        if (from != to) p.moveMediaItem(from, to)
                    }
                    QueueCommands.ACTION_REMOVE_IDS -> {
                        val ids = args.getStringArrayList(QueueCommands.ARG_IDS) ?: return bad
                        BridgeLimits.checkCount(ids.size, "ids")
                        ids.forEach { BridgeLimits.checkString(it, "id") }
                        removeIds(p, ids.toHashSet())
                    }
                    QueueCommands.ACTION_RESTORE -> {
                        val item = tracks()?.singleOrNull() ?: return bad
                        val section = NativeQueue.Section.of(args.getString(QueueCommands.ARG_KIND)) ?: return bad
                        restore(item, section, BridgeLimits.checkString(args.getString(QueueCommands.ARG_BEFORE), "beforeId"))
                    }
                }
            } catch (e: TooLargeException) {
                Log.w(TAG, "$action: too large")
                return failure(QueueCommands.TOO_LARGE)
            }
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
            val ciTone = if (isPlugin(mediaSession, controller) && isDebuggable()) LaunchOptions.CI_TONE else null
            val restored = mediaItems.mapNotNull { item -> sanitize(item, ciTone) }.toMutableList()
            if (restored.size != mediaItems.size) {
                Log.w(TAG, "Dropped ${mediaItems.size - restored.size} item(s) without a valid id")
            }
            return Futures.immediateFuture(restored)
        }
    }

    /** A failed custom command whose [QueueCommands.RESULT_CODE] the plugin rejects with. */
    private fun failure(code: String): ListenableFuture<SessionResult> = Futures.immediateFuture(
        SessionResult(
            SessionError(SessionError.ERROR_BAD_VALUE, code),
            Bundle().apply { putString(QueueCommands.RESULT_CODE, code) },
        ),
    )

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

    /** The JukePlayer plugin's controller (it presents [ControllerKey]); never the notification's. */
    private fun isPlugin(session: MediaSession, controller: MediaSession.ControllerInfo): Boolean =
        SessionPolicy.mayUseQueueCommands(infoOf(session, controller), packageName, ControllerKey.token)

    private fun infoOf(session: MediaSession, controller: MediaSession.ControllerInfo) =
        SessionPolicy.Controller(
            packageName = controller.packageName,
            uid = controller.uid,
            isTrusted = controller.isTrusted,
            isMediaNotificationController = session.isMediaNotificationController(controller),
            isAutoCompanionController = session.isAutoCompanionController(controller),
            isAutomotiveController = session.isAutomotiveController(controller),
            connectionToken = ControllerKey.of(controller.connectionHints),
        )

    companion object {
        private const val TAG = "CyberJukeService"
        private const val RADIO_MAX_RETRIES = 3
        private const val RADIO_RETRY_MS = 15_000L
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

/**
 * Maps cyberjuke://yt/<id> to the real googlevideo URL + headers, on the loader thread. Every
 * load goes through here: only https YouTube media URLs leave it (L5), plus the CI test tone
 * asset on debuggable builds.
 */
@OptIn(UnstableApi::class)
internal object YtDataSpecResolver : ResolvingDataSource.Resolver {
    private val requestNumber = AtomicLong()

    /** Set by PlaybackService: debuggable builds play the CI tone asset. */
    @Volatile
    var allowCiTone = false

    override fun resolveDataSpec(dataSpec: DataSpec): DataSpec {
        val ytId = JukeUris.ytIdOf(dataSpec.uri)
        if (ytId == LaunchOptions.CI_TONE && allowCiTone) {
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
            // An HLS manifest, variant or segment (the manifest-only fallback).
            url = dataSpec.uri.toString()
            headers.putAll(YtCompat.streamHeaders(url))
        }
        if (!Hosts.isAllowedMediaUrl(url)) {
            throw IOException("Refusing to load a non-https or non-YouTube media URL")
        }

        val isVideoPlayback = Uri.parse(url).path?.startsWith("/videoplayback") == true
        val finalUrl = if (ytId != null && YtUrls.wantsRn(url)) {
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
