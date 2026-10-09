package io.github.iamandelib.cyberjuke.playback

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
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
import io.github.iamandelib.cyberjuke.net.BlockReason
import io.github.iamandelib.cyberjuke.net.BlockedException
import io.github.iamandelib.cyberjuke.net.Http
import io.github.iamandelib.cyberjuke.net.NetBlock
import io.github.iamandelib.cyberjuke.net.NetEpoch
import io.github.iamandelib.cyberjuke.net.NetPrefs
import org.json.JSONArray

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
    private lateinit var queueHost: ExoQueueHost

    /** What was playing, kept on disk so the app opens on it again (paused) after a restart. */
    private lateinit var lastSession: LastSessionStore
    private val saveSession = Runnable { saveSessionNow() }

    /** The list changed since it was last saved. */
    private var sessionDirty = false
    private val savePositionTick = object : Runnable {
        override fun run() {
            savePosition()
            if (player?.isPlaying == true) handler.postDelayed(this, POSITION_SAVE_MS)
        }
    }

    // ---- autoplay (AP1, AP4) ----
    /** The Autoplay setting (C3), sent by the web side at start. */
    private var autoplayEnabled = true

    /** The track autoplay follows; null until a list is set through SET_LIST. */
    private var seedId: String? = null
    private var context: Pair<String, String>? = null

    /** What the last "low" check acted on, so each low state is handled once. */
    private var lowKey: String? = null
    private val lowCheck = Runnable { checkLow() }

    /** A Global seed's radio (autoplay for Global tracks). */
    private val radio = RadioFeeder(
        handler,
        object : RadioFeeder.Host {
            override fun ytIdsInPlayer(): Set<String> {
                val p = player ?: return emptySet()
                val ids = HashSet<String>()
                for (i in 0 until p.mediaItemCount) JukeUris.ytIdOf(p.getMediaItemAt(i))?.let { ids.add(it) }
                return ids
            }

            override fun addRadioItems(items: List<MediaItem>): Boolean {
                if (!autoplayEnabled || player?.repeatMode != Player.REPEAT_MODE_OFF) return false
                queue.addAutoplay(items)
                queueChanged()
                return true
            }

            override fun recheckLow(delayMs: Long?) {
                lowKey = null
                if (delayMs == null) return
                handler.removeCallbacks(lowCheck)
                handler.postDelayed(lowCheck, delayMs)
            }
        },
    )

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
            // The new network's kind first: its IPv4 memory must apply before a lifted block
            // resumes playback (onCapabilitiesChanged comes later).
            runCatching { connectivity().getNetworkCapabilities(network) }.getOrNull()?.let {
                if (NetPrefs.onNetwork(networkKey(it))) StreamResolver.clear()
            }
            if (NetEpoch.onNetwork(network.toString())) onNetworkChanged(newNetwork = true)
        }

        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            // The IPv4 setting's Auto memory is per kind of network.
            if (NetPrefs.onNetwork(networkKey(caps))) StreamResolver.clear()
            // Online again (validated): playback an outage stopped picks up again.
            // (Validated fires again and again on a network that's up: at most every few seconds.)
            if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) && NetBlock.resumePending() &&
                SystemClock.elapsedRealtime() - lastNetResumeAt > NET_RESUME_GAP_MS
            ) {
                lastNetResumeAt = SystemClock.elapsedRealtime()
                handler.post { resumeAfterBlock() }
            }
        }

        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            val addresses = linkProperties.linkAddresses.mapNotNull { it.address?.hostAddress }.toSet()
            if (NetEpoch.onAddresses(network.toString(), addresses)) onNetworkChanged(newNetwork = false)
        }
    }
    private var networkCallbackRegistered = false

    private fun connectivity() = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private fun networkKey(caps: NetworkCapabilities): String = when {
        caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        else -> "other"
    }

    /**
     * Any thread (ConnectivityManager's). A new network is a new IP as far as YouTube is
     * concerned: a running back-off is lifted at once (and playback resumes if it stopped it).
     */
    private fun onNetworkChanged(newNetwork: Boolean) {
        StreamResolver.clear()
        Http.evictConnections()
        if (newNetwork) NetBlock.reset(keepLevel = false)
        Log.i(TAG, "Default network changed (generation ${NetEpoch.generation}): stream URLs dropped")
    }

    /** Resumes playback a back-off stopped once it ends (lifted early, or ran out). */
    private val blockListener = object : NetBlock.Listener {
        override fun onBlocked(until: Long, reason: BlockReason) {
            handler.post { scheduleResume(until) }
        }

        override fun onUnblocked() {
            handler.post { blockEnded.run() }
        }
    }

    private val blockEnded = Runnable { resumeAfterBlock() }

    /**
     * Keeps the CPU awake until a pending resume is due: the player is paused (no wake lock of
     * its own), and a Handler's delay doesn't run on while the phone sleeps in a pocket. Only
     * for a resume that can still happen (within [NetBlock.RESUME_WINDOW_MS]); timed.
     */
    private var resumeWakeLock: PowerManager.WakeLock? = null

    /** pauseToResume's pause is on its way to the listener (it isn't the user's). */
    private var ownPause = false

    /** When the list last played to its end (elapsedRealtime). */
    private var endedAt = 0L

    /** The last network-triggered resume (elapsedRealtime). */
    private var lastNetResumeAt = 0L

    private fun scheduleResume(until: Long) {
        handler.removeCallbacks(blockEnded)
        val wait = (until - System.currentTimeMillis()).coerceAtLeast(0L) + BLOCK_END_SLACK_MS
        handler.postDelayed(blockEnded, wait)
        if (!NetBlock.resumePending() || wait > NetBlock.RESUME_WINDOW_MS) return
        try {
            val lock = resumeWakeLock ?: (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CyberJuke:resume")
                .apply { setReferenceCounted(false) }
                .also { resumeWakeLock = it }
            lock.acquire(wait + WAKE_SLACK_MS)
        } catch (e: Exception) {
            Log.w(TAG, "No wake lock for the resume: ${e.javaClass.simpleName}")
        }
    }

    private fun releaseResumeWakeLock() {
        try {
            resumeWakeLock?.takeIf { it.isHeld }?.release()
        } catch (_: Exception) {
        }
    }

    /** Headphones unplugged or Bluetooth gone while a resume waits: it must not start on the speaker. */
    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY || !NetBlock.resumePending()) return
            Log.i(TAG, "Audio output changed while a resume was pending: cancelled")
            NetBlock.cancelResume()
            releaseResumeWakeLock()
        }
    }
    private var noisyRegistered = false

    /**
     * The back-off is over: if it stopped playback (within [NetBlock.RESUME_WINDOW_MS]), play
     * again. That load is also the probe: if YouTube still refuses, the next, longer back-off
     * starts and playback waits again.
     */
    private fun resumeAfterBlock() {
        handler.removeCallbacks(blockEnded)
        val p = player ?: return
        val (until, _) = NetBlock.active()
        if (until > 0L) {
            scheduleResume(until)
            return
        }
        releaseResumeWakeLock()
        if (!NetBlock.takeResume() || p.mediaItemCount == 0) return
        // Another app is playing now: leave it be (and keep our audio focus request out of it).
        val audio = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        if (audio?.isMusicActive == true) {
            Log.i(TAG, "Back-off over, but other audio is playing: not resuming")
            return
        }
        Log.i(TAG, "Resuming after a back-off or an outage")
        when (p.playbackState) {
            Player.STATE_IDLE -> p.prepare()
            Player.STATE_ENDED -> return
            else -> Unit
        }
        p.play()
    }

    override fun onCreate() {
        super.onCreate()
        lastSession = LastSessionStore(this)
        // Before anything touches the network: the IPv4 setting applies to extraction and streams.
        NetPrefsStore.load(this)
        NetBlock.add(blockListener)
        // A back-off already running (the service was restarted): resume when it ends.
        NetBlock.active().first.takeIf { it > 0L }?.let { scheduleResume(it) }
        try {
            val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
            // A system broadcast: delivered to a non-exported receiver too.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(noisyReceiver, filter)
            }
            noisyRegistered = true
        } catch (e: Exception) {
            Log.w(TAG, "No becoming-noisy receiver: ${e.javaClass.simpleName}")
        }
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
        // Audio only: a muxed or HLS fallback stream must not start a video (or text) decoder.
        exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, true)
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            .setTrackTypeDisabled(C.TRACK_TYPE_IMAGE, true)
            .build()
        queueHost = ExoQueueHost(exo)
        queue = NativeQueue(queueHost)
        exo.addListener(PlayerListener())
        player = exo

        // A tap on the media notification (or the lock screen's player) opens Now Playing.
        val openApp = Intent(this, MainActivity::class.java)
            .setAction(LaunchOptions.ACTION_NOW_PLAYING)
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
        restoreLastSession()
        Log.i(TAG, "PlaybackService created")
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
        mediaSession

    override fun onTaskRemoved(rootIntent: Intent?) {
        savePosition()
        val p = player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0 ||
            p.playbackState == Player.STATE_ENDED || p.playbackState == Player.STATE_IDLE
        ) {
            Log.i(TAG, "Task removed while not playing: stopping service")
            // Swiped away: nothing may start playing by itself later.
            NetBlock.cancelResume()
            pauseAllPlayersAndStopSelf()
        }
    }

    override fun onDestroy() {
        Log.i(TAG, "PlaybackService destroyed")
        // The latest list and position, before the player goes.
        if (sessionDirty) saveSessionNow()
        savePosition()
        handler.removeCallbacks(saveSession)
        handler.removeCallbacks(savePositionTick)
        lastSession.close()
        handler.removeCallbacks(prefetchCheck)
        handler.removeCallbacks(lowCheck)
        handler.removeCallbacks(blockEnded)
        NetBlock.remove(blockListener)
        NetBlock.cancelResume()
        releaseResumeWakeLock()
        if (noisyRegistered) {
            runCatching { unregisterReceiver(noisyReceiver) }
            noisyRegistered = false
        }
        radio.shutdown()
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
            if (playbackState == Player.STATE_ENDED) endedAt = SystemClock.elapsedRealtime()
            // Loading again (a restored session's first Play, or a retry): autoplay may top up.
            if (playbackState != Player.STATE_IDLE) {
                handler.removeCallbacks(lowCheck)
                handler.post(lowCheck)
            }
            if (playbackState == Player.STATE_READY) {
                consecutiveFailures = 0
                player?.currentMediaItem?.mediaId?.let { expiredRetried.remove(it) }
                // No NetBlock.success() here: READY from a cached URL or buffered bytes proves
                // nothing about YouTube; a successful extraction or InnerTube request does (M1).
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            schedulePrefetch()
            // Where it stopped, and while it plays every few seconds (a crash loses no more).
            handler.removeCallbacks(savePositionTick)
            savePosition()
            if (isPlaying) handler.postDelayed(savePositionTick, POSITION_SAVE_MS)
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            // Our own pause (pauseToResume) arrives here after it returned (Media3 queues events
            // raised inside onPlayerError): it must not cancel the resume it asked for.
            if (!playWhenReady && ownPause) {
                ownPause = false
                return
            }
            // A pause outside a back-off is the user's: nothing to resume later. (During one,
            // a refused play the plugin turned into a pause keeps its resume.)
            if (!playWhenReady && !NetBlock.isBlocked()) {
                NetBlock.cancelResume()
                releaseResumeWakeLock()
            }
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int,
        ) {
            schedulePrefetch()
            if (reason == Player.DISCONTINUITY_REASON_SEEK) savePosition()
        }

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
            // Something was added after the list had played to its end (late autoplay, Add to
            // queue, Undo): ExoPlayer stays ENDED, so go on to it.
            // Only soon after the end: a batch arriving much later (after a long back-off, or on
            // reopening the app) must not start music by itself.
            val p = player ?: return
            if (p.playbackState == Player.STATE_ENDED && p.playWhenReady && p.hasNextMediaItem() &&
                SystemClock.elapsedRealtime() - endedAt < CONTINUE_AFTER_END_MS
            ) {
                Log.i(TAG, "Items added after the end: continuing")
                p.seekToNextMediaItem()
            }
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
        radio.reseed(seed)
        lowKey = null
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
            radio.stop()
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
        // Saved a moment later: a burst of changes (a new list, then its autoplay) writes once.
        sessionDirty = true
        handler.removeCallbacks(saveSession)
        handler.postDelayed(saveSession, SESSION_SAVE_DELAY_MS)
    }

    /**
     * AP4: with 5 autoplay items or fewer to go, get more. A Global radio is refilled here;
     * Jukebox picks come from the web side (`queueLow`). Nothing with autoplay off or repeat on.
     */
    private fun checkLow() {
        val p = player ?: return
        // Nothing loading (a restored session before its first Play): no requests for more yet.
        val idle = p.playbackState == Player.STATE_IDLE && !p.playWhenReady
        if (!autoplayEnabled || p.repeatMode != Player.REPEAT_MODE_OFF || p.mediaItemCount == 0 || seedId == null || idle) {
            lowKey = null
            QueueInfo.clearLow()
            return
        }
        val left = queue.autoAhead()
        if (left > QueueCommands.LOW) {
            lowKey = null
            QueueInfo.clearLow()
            return
        }
        val key = "$seedId|$left|${p.currentMediaItemIndex}|${p.mediaItemCount}"
        if (key == lowKey) return
        lowKey = key
        if (radio.active) radio.refill() else QueueInfo.emitQueueLow(left, seedId)
    }

    // ---- the last session ---------------------------------------------------------------------

    /**
     * After the app was swiped away, stopped, killed or crashed: the service starts with an
     * empty player, and what was playing comes back, paused and not loaded (no request, no
     * notification) until Play.
     */
    private fun restoreLastSession() {
        val p = player ?: return
        if (p.mediaItemCount > 0) return
        val s = lastSession.load(::isRestorable) ?: return
        val items = try {
            s.entries.mapIndexed { i, e -> restoredItem(e, if (i == s.index) s.durationMs else 0L) }
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "Last session not restorable: ${e.javaClass.simpleName}")
            lastSession.clear()
            return
        }
        p.repeatMode = s.repeat
        p.shuffleModeEnabled = s.shuffle
        queue.restoreSession(items, s.entries.map { it.section }, s.index, s.positionMs, s.order)
        context = s.context
        radio.reseed(items.firstOrNull { it.mediaId == s.seedId })
        seedId = s.seedId
        queueChanged()
        Log.i(TAG, "Restored the last session: ${items.size} item(s), paused")
    }

    /** A saved track's ytId this build can play (the CI tone in debuggable builds too). */
    private fun isRestorable(ytId: String): Boolean =
        SessionPolicy.isValidYtId(ytId) || (ytId == LaunchOptions.CI_TONE && YtDataSpecResolver.allowCiTone)

    private fun restoredItem(e: LastSession.Entry, durationMs: Long): MediaItem {
        val item = if (e.ytId == LaunchOptions.CI_TONE) {
            MediaItem.Builder()
                .setMediaId(e.id)
                .setUri(JukeUris.forYt(e.ytId))
                .setMediaMetadata(MediaMetadata.Builder().setTitle(e.title).setArtist(e.artist).build())
                .build()
        } else {
            JukeTracks.toMediaItem(e.toNativeTrack())
        }
        if (durationMs <= 0L) return item
        // Its length, for Now Playing before the track loads (StateEncoder).
        return item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon().setDurationMs(durationMs).build()).build()
    }

    private fun saveSessionNow() {
        handler.removeCallbacks(saveSession)
        sessionDirty = false
        val p = player ?: return
        val s = sessionOf(p)
        if (s == null) lastSession.clear() else lastSession.save(s)
    }

    private fun sessionOf(p: ExoPlayer): LastSession? {
        val n = p.mediaItemCount
        if (n == 0) return null
        val pending = queue.pendingSerials
        val entries = ArrayList<LastSession.Entry>(n)
        for (i in 0 until n) {
            val item = p.getMediaItemAt(i)
            val extras = item.mediaMetadata.extras
            val serial = extras?.getLong(JukeCommands.EXTRA_QUEUE_SERIAL, 0L) ?: 0L
            val extra = TrackExtras.get(item.mediaId)
            entries.add(
                LastSession.Entry(
                    id = item.mediaId,
                    ytId = JukeUris.ytIdOf(item) ?: return null,
                    title = item.mediaMetadata.title?.toString(),
                    artist = item.mediaMetadata.artist?.toString(),
                    artworkUrl = item.mediaMetadata.artworkUri?.toString(),
                    by = extra?.by,
                    postUrl = extra?.postUrl,
                    section = when {
                        serial != 0L && serial in pending -> NativeQueue.Section.QUEUED
                        extras?.getBoolean(QueueCommands.EXTRA_AUTOPLAY, false) == true -> NativeQueue.Section.AUTO
                        else -> NativeQueue.Section.LIST
                    },
                ),
            )
        }
        return LastSession.of(
            entries, p.currentMediaItemIndex, positionOf(p), durationOf(p), p.shuffleModeEnabled,
            queueHost.shuffleOrder(), p.repeatMode, context, seedId,
        )
    }

    private fun savePosition() {
        val p = player ?: return
        val item = p.currentMediaItem ?: return
        lastSession.savePosition(p.currentMediaItemIndex, item.mediaId, positionOf(p), durationOf(p))
    }

    /** A list that played to its end comes back at the start of its last track. */
    private fun positionOf(p: Player): Long =
        if (p.playbackState == Player.STATE_ENDED) 0L else p.currentPosition.coerceAtLeast(0L)

    private fun durationOf(p: Player): Long =
        p.duration.takeIf { it != C.TIME_UNSET && it > 0L } ?: p.currentMediaItem?.mediaMetadata?.durationMs ?: 0L

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
            viaIpv6 = served?.let { StreamUrls.boundToIpv6(it.url) } == true,
            canSwitchToIpv4 = NetPrefs.canSwitchToIpv4(),
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
                // A back-off is running (or was, when this load failed): stay here, paused,
                // without a request. Playback resumes by itself once it ends.
                pauseToResume(p, afterBlock = true)
            }
            is TrackErrorPolicy.Action.Block -> {
                Log.i(TAG, "BLOCKED ${action.reason} on $trackId: $message")
                // An extraction's limit was counted already, when YtGuard tripped (this error may
                // surface much later, at a track change): only a stream's refusal counts here.
                if (resolve == null) NetBlock.trip(action.reason)
                StreamResolver.cancelPrefetch()
                // The rejected URL must not be tried again from the cache (L1).
                ytId?.let { StreamResolver.reResolve(it) }
                pauseToResume(p, afterBlock = true)
            }
            TrackErrorPolicy.Action.SwitchToIpv4 -> {
                if (ytId == null) {
                    perVideoFailure(p, index, trackId, ytId, message, error)
                    return
                }
                // Refused over IPv6: IPv4 for this network from now on (drops cached URLs),
                // then a fresh link at the same position.
                Log.i(TAG, "HTTP ${http?.responseCode} over IPv6 for $trackId: switching to IPv4")
                NetPrefs.switchToIpv4Automatically()
                reResolveAndRetry(p, index, item, trackId, ytId)
            }
            TrackErrorPolicy.Action.ReResolve -> {
                if (ytId == null) {
                    perVideoFailure(p, index, trackId, ytId, message, error)
                    return
                }
                // Expired URL (or a new network address, or a refusal): same itag, same position.
                Log.i(TAG, "HTTP ${http?.responseCode} for $trackId: re-resolving once")
                reResolveAndRetry(p, index, item, trackId, ytId)
            }
            is TrackErrorPolicy.Action.Pause -> {
                Log.i(TAG, "TRACK_ERROR $trackId (yt=$ytId), pausing: $message")
                if (action.broken) p.pause() else pauseToResume(p) // offline: back when the network is
                PlayerBus.emitTrackError(trackId, message, false)
            }
            else -> perVideoFailure(p, index, trackId, ytId, message, error)
        }
    }

    /** Fetches a fresh stream link for the item once and loads it again at the same position. */
    private fun reResolveAndRetry(p: ExoPlayer, index: Int, item: MediaItem, trackId: String, ytId: String) {
        expiredRetried.add(trackId)
        StreamResolver.reResolve(ytId)
        if (item.localConfiguration?.uri?.scheme != JukeUris.SCHEME) {
            // Swapped to its HLS manifest earlier: that manifest is what expired (L15).
            // Back to our URI, so the resolver fetches a fresh one.
            p.replaceMediaItem(index, item.buildUpon().setUri(JukeUris.forYt(ytId)).setMimeType(null).build())
        }
        p.prepare()
    }

    /**
     * Pauses for a back-off or an outage; if it was playing, it resumes once the back-off ends
     * or the network is back (within [NetBlock.RESUME_WINDOW_MS]).
     */
    private fun pauseToResume(p: ExoPlayer, afterBlock: Boolean = false) {
        val wasPlaying = p.playWhenReady
        if (wasPlaying) ownPause = true
        p.pause()
        if (!wasPlaying) return
        NetBlock.wantResume()
        if (!afterBlock) return // an outage: back when the network is validated again
        // The resume's timer and wake lock, now that it is wanted. A back-off that already
        // ran out by the time its error surfaced (at a track change): try again at once.
        val until = NetBlock.active().first
        if (until > 0L) scheduleResume(until) else handler.post { resumeAfterBlock() }
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

        /** Resume a little after the back-off's end, so the check sees it over. */
        private const val BLOCK_END_SLACK_MS = 500L

        /** The resume wake lock outlasts the wait by this much (then it times out by itself). */
        private const val WAKE_SLACK_MS = 15_000L

        /** Items added this soon after the list ended play on; later ones wait for Play. */
        private const val CONTINUE_AFTER_END_MS = 2L * 60_000L

        /** At most one network-triggered resume per this long. */
        private const val NET_RESUME_GAP_MS = 10_000L

        /** The list is saved this long after it last changed. */
        private const val SESSION_SAVE_DELAY_MS = 1_000L

        /** While playing, the position is saved this often. */
        private const val POSITION_SAVE_MS = 15_000L
    }
}
