package io.github.iamandelib.cyberjuke.playback

import android.app.ActivityManager
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
import android.view.KeyEvent
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.LoadEventInfo
import androidx.media3.exoplayer.source.MediaLoadData
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.mp3.Mp3Extractor
import androidx.media3.session.CommandButton
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
import io.github.iamandelib.cyberjuke.R
import io.github.iamandelib.cyberjuke.findCause
import io.github.iamandelib.cyberjuke.net.BlockReason
import io.github.iamandelib.cyberjuke.net.BlockedException
import io.github.iamandelib.cyberjuke.net.Family
import io.github.iamandelib.cyberjuke.net.Http
import io.github.iamandelib.cyberjuke.net.NetBlock
import io.github.iamandelib.cyberjuke.net.NetEpoch
import io.github.iamandelib.cyberjuke.net.NetEpochState
import io.github.iamandelib.cyberjuke.net.NetPrefs
import org.json.JSONArray
import java.io.EOFException
import java.net.SocketException

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
    /** Outage pauses in a row with nothing played between ([TrackErrorPolicy.Facts.outagePauses]). */
    private var outagePauses = 0

    /** mediaIds already re-resolved once after an HTTP 403/410 (expired stream URL). */
    private val expiredRetried = HashSet<String>()

    /** The last item that played (its stream worked): TrackErrorPolicy.Facts.playedThisItem. */
    private var lastReadyId: String? = null

    /** Unclear I/O failures at one spot of the current item: TrackErrorPolicy.Facts.failuresHere. */
    private val failureSpot = FailureSpot()

    /** The [player]'s load control: the playing item and the next one only, told which they are ([updateLoadAhead]). */
    private var oneAhead: OneAheadLoadControl? = null

    /**
     * Where every player of the service loads from ([buildPlayer]): YouTube audio and Jukebox
     * MP3s through the listening cache, the network behind it, with the resolver giving each load
     * its URL and key.
     */
    private lateinit var dataSources: DataSource.Factory

    private val audioAttributes = AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
        .build()

    /** The service's listeners, on whichever player it has now ([adopt]). */
    private val listener = PlayerListener()

    // A load finished (a track all buffered; isLoading may stay true for a gated one): the
    // liked saver looks again, as playback may not need the network any more.
    private val loadListener = object : AnalyticsListener {
        override fun onLoadCompleted(eventTime: AnalyticsListener.EventTime, loadEventInfo: LoadEventInfo, mediaLoadData: MediaLoadData) {
            likedSaver.check()
        }
    }

    /** The crossfade between tracks (Settings → Crossfade; Off by default). */
    private var crossfade: Crossfader? = null

    /** Its listener, on whichever player is the service's ([adopt]). */
    private var crossfadeEvents: CrossfadeEvents? = null

    /** During a crossfade, until the old track ends: the player fading in the next one, outside the session ([startIncoming]). */
    private var incoming: Built? = null

    /** Its listener until then. */
    private var incomingEvents: IncomingEvents? = null

    /** onDestroy has begun: nothing waits for the handler any more. */
    private var destroying = false

    /** The Crossfade setting, in ms (0 = Off), as the load-ahead needs it ([LoadAhead.wanted]). */
    private var crossfadeMs = 0

    /** Gapless playback (Settings; on by default): the next track is readied while this one plays ([LoadAhead]). */
    private var gapless = true

    /** The gap at a track's own end, for the debug log ([TransitionWatch]; no ids). */
    private val transitions = TransitionWatch()
    private val transitionDeadline = Runnable { judged(transitions.onDeadline(SystemClock.elapsedRealtime())) }

    /** Auto quality's rung, decided as each track starts. */
    private val governor = QualityGovernor()

    /** The setting the governor last saw (a change starts its probing over). */
    private var governedQuality: AudioQuality? = null

    /** Tells a rebuffer from the buffering of a seek, a skip or a list change. */
    private val rebuffers = RebufferDetector()

    /**
     * Retries after an outage pause while the network stays validated (a weak link stalled
     * the track: no callback will come). One postDelayed at most, only while that pause is
     * pending; cancelled on a pause by the user, becoming noisy, stop and onDestroy.
     */
    private val resumeSchedule = ResumeSchedule()
    private val outageRetry = Runnable { retryAfterOutage() }

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
                val p = player ?: return false
                if (!autoplayEnabled || !Stations.mayAutoplay(p.repeatMode, p.mediaItemCount)) return false
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

    /** The playing track and the next, the pair that may open its stream ([updateLoadAhead]). */
    private var loadingIds: Set<String> = emptySet()

    /** Saves liked songs into the listening cache while the service runs anyway. */
    private val likedSaver = LikedSaver(
        handler,
        object : LikedSaver.Host {
            override fun loadingPair(): Set<String> = loadingIds

            override fun stillLoading(): Set<String> {
                val p = player ?: return emptySet()
                val next = p.nextMediaItemIndex
                val nextId = if (next == C.INDEX_UNSET || next >= p.mediaItemCount) null else JukeUris.audioIdOf(p.getMediaItemAt(next))
                return PlaybackNeed.stillLoading(loadOf(p), JukeUris.audioIdOf(p.currentMediaItem), nextId)
            }

            override fun playbackNeedsNetwork(): Boolean = player?.let { PlaybackNeed.needsNetwork(loadOf(it)) } == true
        },
    )

    private val window = Timeline.Window()

    /** What the player has buffered, for [PlaybackNeed] (its isLoading says little: see there). */
    private fun loadOf(p: ExoPlayer): PlaybackNeed.Load {
        val next = p.nextMediaItemIndex
        return PlaybackNeed.Load(
            idle = p.playbackState == Player.STATE_IDLE || p.playbackState == Player.STATE_ENDED,
            buffering = p.playbackState == Player.STATE_BUFFERING,
            positionMs = p.currentPosition.coerceAtLeast(0L),
            durationMs = p.duration.takeIf { it != C.TIME_UNSET } ?: -1L,
            bufferedPositionMs = p.bufferedPosition,
            totalBufferedMs = p.totalBufferedDuration,
            // A next track that isn't loading ahead (Gapless off) is nothing to wait for.
            hasNext = next != C.INDEX_UNSET && LoadAhead.wanted(gapless, crossfadeMs),
            nextDurationMs = durationOf(p, next, window),
            isLoading = p.isLoading,
        )
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
            // The new network's kind first: its IPv4 memory must apply before a lifted block
            // resumes playback (onCapabilitiesChanged comes later).
            runCatching { connectivity().getNetworkCapabilities(network) }.getOrNull()?.let {
                if (NetPrefs.onNetwork(networkKey(it))) StreamResolver.clear()
            }
            if (NetEpoch.onNetwork(network.toString())) onNetworkChanged(newNetwork = true, NetEpochState.ALL_FAMILIES)
        }

        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            // The IPv4 setting's Auto memory is per kind of network.
            if (NetPrefs.onNetwork(networkKey(caps))) StreamResolver.clear()
            // Online, and on Wi-Fi (unmetered): the liked saver's saves (it acts on a change only).
            val validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            val unmetered = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
            AudioCache.online = validated
            handler.post { likedSaver.onNetwork(validated, unmetered) }
            // Online again (validated): playback an outage stopped picks up again.
            // (Validated fires again and again on a network that's up: at most every few seconds.)
            if (validated && NetBlock.resumePending() &&
                SystemClock.elapsedRealtime() - lastNetResumeAt > NET_RESUME_GAP_MS
            ) {
                lastNetResumeAt = SystemClock.elapsedRealtime()
                handler.post { resumeAfterBlock() }
            }
        }

        override fun onLost(network: Network) {
            AudioCache.online = false
            handler.post { likedSaver.onNetwork(validated = false, unmetered = false) }
        }

        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            val addresses = linkProperties.linkAddresses.mapNotNull { it.address?.hostAddress }.toSet()
            val changed = NetEpoch.addressesChanged(network.toString(), addresses)
            if (changed.isNotEmpty()) onNetworkChanged(newNetwork = false, changed)
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
     * Stream URLs bound to an address family that changed go (a new IPv6 address leaves the
     * IPv4-bound ones working); the next track's is fetched again if it went.
     */
    private fun onNetworkChanged(newNetwork: Boolean, families: Set<Family>) {
        StreamResolver.dropBoundTo(families)
        Http.evictConnections()
        if (newNetwork) NetBlock.reset(keepLevel = false)
        handler.post {
            prefetchedKey = null
            schedulePrefetch()
        }
        Log.i(TAG, "Default network changed (generation ${NetEpoch.generation}): stream URLs bound to $families dropped")
    }

    private fun isNetworkValidated(): Boolean = try {
        val cm = connectivity()
        cm.getNetworkCapabilities(cm.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
    } catch (e: Exception) { // SecurityException without ACCESS_NETWORK_STATE
        true
    }

    /** Resumes playback a back-off stopped once it ends (lifted early, or ran out). */
    private val blockListener = object : NetBlock.Listener {
        override fun onBlocked(until: Long, reason: BlockReason) {
            handler.post {
                scheduleResume(until)
                likedSaver.check() // a running save stops
            }
        }

        override fun onUnblocked() {
            handler.post {
                blockEnded.run()
                likedSaver.check()
            }
        }

        // Stopped by a back-off while playing, or Play pressed during one: where the sound was
        // going, and the resume's timer, now with its wake lock. An MP3 doesn't wait for the
        // back-off (its outage tries keep their own wake lock), so nothing stays awake for it.
        override fun onResumeWanted() {
            handler.post {
                pausedOnExternal = hasExternalOutput()
                if (!BackOffHold.resumeWaits(blocked = true, currentIsMp3 = JukeUris.isMp3(player?.currentMediaItem))) return@post
                NetBlock.active().first.takeIf { it > 0L }?.let { scheduleResume(it) }
            }
        }

        // Paused in the app (or anywhere else) while a resume waited: no reason to stay awake.
        override fun onResumeCancelled() {
            handler.post { releaseResumeWakeLock() }
        }
    }

    private val blockEnded = Runnable { resumeAfterBlock() }

    /**
     * Keeps the CPU awake until a pending resume is due, or an outage's next try: the player is
     * paused (no wake lock of its own), and a Handler's delay doesn't run on while the phone
     * sleeps in a pocket. Only for a resume that can still happen (within
     * [NetBlock.RESUME_WINDOW_MS]); timed.
     */
    private var resumeWakeLock: PowerManager.WakeLock? = null

    /** pauseToResume's pause is on its way to the listener (it isn't the user's). */
    private var ownPause = false

    /** Headphones or Bluetooth were connected when the resume was asked for. */
    private var pausedOnExternal = false

    private fun hasExternalOutput(): Boolean = try {
        val audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        AudioOutputs.hasExternal(audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { it.type }.toIntArray())
    } catch (e: Exception) {
        false
    }

    /**
     * Android 12+ lets a service start in the foreground from the background only in some
     * cases: a resume when the app has neither its page nor its playback in the foreground any
     * more (paused longer than Media3 keeps it there) would play without one, and be stopped.
     */
    private fun mayStartPlaybackNow(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        // A visible window (on top or not) may start one too.
        return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
    }

    /** When the list last played to its end (elapsedRealtime). */
    private var endedAt = 0L

    /** The last network-triggered resume (elapsedRealtime). */
    private var lastNetResumeAt = 0L

    private fun scheduleResume(until: Long) {
        handler.removeCallbacks(blockEnded)
        val wait = (until - System.currentTimeMillis()).coerceAtLeast(0L) + BLOCK_END_SLACK_MS
        handler.postDelayed(blockEnded, wait)
        if (!NetBlock.resumePending() || wait > NetBlock.RESUME_WINDOW_MS) return
        keepAwakeFor(wait)
    }

    /** [resumeWakeLock] for [ms] and a little more (a new call sets a new timeout). */
    private fun keepAwakeFor(ms: Long) {
        try {
            val lock = resumeWakeLock ?: (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CyberJuke:resume")
                .apply { setReferenceCounted(false) }
                .also { resumeWakeLock = it }
            lock.acquire(ms + WAKE_SLACK_MS)
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
            stopOutageRetry()
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
        if (until > 0L && BackOffHold.resumeWaits(blocked = true, currentIsMp3 = JukeUris.isMp3(p.currentMediaItem))) {
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
        // Headphones unplugged or Bluetooth gone meanwhile (the becoming-noisy broadcast isn't
        // sent while nothing plays): not on the speaker.
        if (pausedOnExternal && !hasExternalOutput()) {
            Log.i(TAG, "Back-off over, but the headphones or Bluetooth output is gone: not resuming")
            return
        }
        if (!mayStartPlaybackNow()) {
            Log.i(TAG, "Back-off over, but the app is in the background: not resuming")
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
        // The page's settings as it last sent them (it may not be there to send them again).
        autoplayEnabled = PlayerPrefsStore.autoplay(this)
        StreamResolver.quality = PlayerPrefsStore.quality(this)
        crossfadeMs = PlayerPrefsStore.crossfadeMs(this)
        gapless = PlayerPrefsStore.gapless(this)
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
            connectivity().registerDefaultNetworkCallback(networkCallback)
            networkCallbackRegistered = true
        } catch (e: Exception) { // SecurityException without ACCESS_NETWORK_STATE, or too many callbacks
            Log.w(TAG, "No network callback: ${e.javaClass.simpleName}")
        }

        // DefaultDataSource handles asset:// (CI test tone) and delegates http(s) to OkHttp,
        // with the streaming timeouts (a stall is noticed, and retried, while the buffer plays).
        // YouTube audio and Jukebox MP3s go through the listening cache in between (the resolver
        // gives each its key): what plays is kept, and what's kept whole plays without the network.
        AudioCache.init(this, PlayerPrefsStore.cacheMb(this), PlayerPrefsStore.downloadOnMobileData(this))
        AudioCache.addListener(likedSaver.cacheListener)
        AudioCache.addLikedListener(likedSaver.likedListener)
        val upstream = DefaultDataSource.Factory(this, OkHttpDataSource.Factory(Http.streaming))
        val cacheSources = AudioCache.dataSourceFactory(upstream)
        dataSources = ResolvingDataSource.Factory(cacheSources, YtDataSpecResolver)

        // Crossfade (Settings), after Metrolist: at a fade a second player starts the next track
        // while this one plays out its end, and becomes the service's when it has (CrossfadeHost).
        val fader = Crossfader(
            ExoCrossfadeHost(
                handler,
                main = { player },
                incoming = { incoming?.player },
                gapless = { gapless },
                start = ::startIncoming,
                hand = ::handOver,
                drop = ::dropIncoming,
            ),
            crossfadeMs,
        )
        crossfade = fader
        crossfadeEvents = CrossfadeEvents(fader)
        incomingEvents = IncomingEvents(fader)

        adopt(buildPlayer())
        val exo = checkNotNull(player)
        queueHost = ExoQueueHost { checkNotNull(player) }
        queue = NativeQueue(queueHost)

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

        mediaSession = MediaSession.Builder(this, SessionPlayer(exo))
            .setSessionActivity(sessionActivity)
            .setCallback(SessionCallback())
            .build()

        // The status bar shows the app's jukebox, not Media3's generic music note.
        setMediaNotificationProvider(
            DefaultMediaNotificationProvider.Builder(this).build().apply { setSmallIcon(R.drawable.ic_stat_cyberjuke) },
        )
        restoreLastSession()
        updateModeButtons()
        // The network as it is now (the callback then tells of changes).
        val caps = runCatching { connectivity().let { it.getNetworkCapabilities(it.activeNetwork) } }.getOrNull()
        AudioCache.online = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) ?: isNetworkValidated()
        caps?.let { likedSaver.onNetwork(AudioCache.online, it.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) }
        Log.i(TAG, "PlaybackService created")
    }

    /**
     * The notification's and lock screen's Shuffle and Repeat ([ModeButtons]), showing the modes as
     * they are: set again whenever one changes, whoever changed it. Player commands the
     * notification may already send (SessionPolicy), so a press takes the same path as the app's.
     */
    private fun updateModeButtons() {
        val p = player ?: return
        val shuffle = p.shuffleModeEnabled
        val repeat = p.repeatMode
        mediaSession?.setMediaButtonPreferences(
            listOf(
                CommandButton.Builder(ModeButtons.shuffleIcon(shuffle))
                    .setDisplayName(ModeButtons.shuffleLabel(shuffle))
                    .setPlayerCommand(Player.COMMAND_SET_SHUFFLE_MODE)
                    .build(),
                CommandButton.Builder(ModeButtons.repeatIcon(repeat))
                    .setDisplayName(ModeButtons.repeatLabel(repeat))
                    .setPlayerCommand(Player.COMMAND_SET_REPEAT_MODE, ModeButtons.nextRepeat(repeat))
                    .build(),
            ),
        )
    }

    /** A player the service's way, not yet its own ([adopt]), with the load control only it may use. */
    private class Built(val player: ExoPlayer, val loadControl: OneAheadLoadControl)

    /**
     * A new player for the service: the shared sources ([dataSources]), a load control of its own
     * (two players can't share one), audio focus ([handleAudioFocus]) and becoming-noisy handled, a
     * wake lock while it plays, audio only.
     */
    private fun buildPlayer(handleAudioFocus: Boolean = true): Built {
        // A deeper buffer than Media3's default (BufferPolicy): short drops are never heard. Only
        // the playing item and the next one load (OneAheadLoadControl).
        val loadControl = OneAheadLoadControl(
            DefaultLoadControl.Builder()
                .setBufferDurationsMs(
                    BufferPolicy.MIN_MS,
                    BufferPolicy.MAX_MS,
                    BufferPolicy.START_MS,
                    BufferPolicy.AFTER_REBUFFER_MS,
                )
                .setPrioritizeTimeOverSizeThresholds(true)
                .setBackBuffer(BufferPolicy.BACK_MS, /* retainBackBufferFromKeyframe = */ false)
                .setTargetBufferBytes(BufferPolicy.TARGET_BYTES)
                .build(),
        )
        // A Jukebox MP3 without a seek table (no Xing/VBRI header) is still seekable, at its
        // constant bitrate; YouTube's streams (fMP4, WebM) have their own index. Its ID3 tags
        // are not read: the post says what it is (an embedded picture would otherwise go to
        // the notification and every controller, whatever its size). It is read as an MP3 only
        // (JukeExtractors).
        val extractors = JukeExtractors(
            DefaultExtractorsFactory()
                .setConstantBitrateSeekingEnabled(true)
                .setMp3ExtractorFlags(Mp3Extractor.FLAG_DISABLE_ID3_METADATA),
            mp3Flags = Mp3Extractor.FLAG_DISABLE_ID3_METADATA or Mp3Extractor.FLAG_ENABLE_CONSTANT_BITRATE_SEEKING,
        )
        val exo = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSources, extractors).setLoadErrorHandlingPolicy(JukeLoadErrorPolicy()))
            .setLoadControl(loadControl)
            .setAudioAttributes(audioAttributes, handleAudioFocus)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        // Audio only: a muxed or HLS fallback stream must not start a video (or text) decoder.
        exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, true)
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            .setTrackTypeDisabled(C.TRACK_TYPE_IMAGE, true)
            .build()
        return Built(exo, loadControl)
    }

    /**
     * Makes [built] the service's player: the service's listeners move to it from the one it had,
     * and the media session follows it (Media3 sends every controller, the notification's and the
     * page's, the new player's whole state, its list included).
     */
    private fun adopt(built: Built) {
        val next = built.player
        player?.let { old ->
            old.removeListener(listener)
            old.removeAnalyticsListener(loadListener)
            crossfadeEvents?.let { old.removeListener(it) }
        }
        // First: its stop at a track's end during a fade is handed over before the others hear of it.
        crossfadeEvents?.let { next.addListener(it) }
        next.addListener(listener)
        next.addAnalyticsListener(loadListener)
        player = next
        oneAhead = built.loadControl
        mediaSession?.player = SessionPlayer(next)
    }

    /**
     * The session's view of [player] (Media3's ForwardingPlayer, for every controller: the app,
     * the notification, headphones). A Next during a crossfade goes to the track fading in, where
     * it is (Crossfader.takeNext), instead of that track starting again from its start.
     */
    private inner class SessionPlayer(p: ExoPlayer) : ForwardingPlayer(p) {
        override fun seekToNext() {
            if (!takeNext()) super.seekToNext()
        }

        override fun seekToNextMediaItem() {
            if (!takeNext()) super.seekToNextMediaItem()
        }

        private fun takeNext() = crossfade?.takeNext(repeatOne = repeatMode == Player.REPEAT_MODE_ONE) == true
    }

    /**
     * A crossfade's start (Metrolist's startCrossfade): a second player plays the track the fade
     * goes into from its start, at volume 0 (Crossfader fades it in), outside the session and
     * without audio focus; the service's player keeps both, and the controls, and stops at its
     * own track's end ([handOver] then). False when no player could be made: nothing changed.
     */
    private fun startIncoming(): Boolean {
        val old = player ?: return false
        val target = crossfadeTarget(old)
        if (target == C.INDEX_UNSET || target >= old.mediaItemCount || incoming != null) return false
        val built = try {
            buildPlayer(handleAudioFocus = false)
        } catch (e: RuntimeException) {
            Log.w(ExoCrossfadeHost.TAG, "Crossfade: no second player: ${e.javaClass.simpleName}")
            return false
        }
        val next = built.player
        try {
            // The same items (the same MediaItem objects), order, modes and speed.
            next.setMediaItems(List(old.mediaItemCount) { old.getMediaItemAt(it) }, target, 0L)
            next.setShuffleOrder(old.shuffleOrder)
            next.repeatMode = old.repeatMode
            next.shuffleModeEnabled = old.shuffleModeEnabled
            next.playbackParameters = old.playbackParameters
            next.volume = 0f
            // Its load control knows its pair before it loads (the gate holds the item after next
            // until the hand-over).
            built.loadControl.currentIndex = target
            built.loadControl.nextIndex = LoadAhead.nextToLoad(LoadAhead.wanted(gapless, crossfadeMs), next.nextMediaItemIndex)
            incomingEvents?.let { next.addListener(it) }
            next.prepare()
            next.play()
        } catch (e: RuntimeException) {
            Log.w(ExoCrossfadeHost.TAG, "Crossfade: no second player: ${e.javaClass.simpleName}")
            next.release()
            return false
        }
        incoming = built
        // The old player stops at its track's end, where the new one takes over, and loads
        // nothing past it (updateLoadAhead keeps it so).
        old.pauseAtEndOfMediaItems = true
        updateLoadAhead()
        return true
    }

    /**
     * The crossfade's hand-over (Metrolist's performCrossfadeSwap, at the old track's end instead of
     * the fade's start): the incoming player, its list brought in step with edits made during the
     * fade, becomes the service's: the session (title, notification, lock screen, controls), the
     * queue, the listeners and the audio focus move to it. The old one goes.
     */
    private fun handOver() {
        val built = incoming ?: return
        val old = player ?: return
        val next = built.player
        incoming = null
        incomingEvents?.let { next.removeListener(it) }
        bringInStep(old, next)
        adopt(built)
        letGo(old, next)
        updateLoadAhead()
        // The new player moved to its track with nobody listening: a track change's bookkeeping
        // (the queue, autoplay, the saved session, prefetch, Auto quality) runs now, as for a
        // jump: its start isn't a rebuffer, nor a track's own end to judge.
        listener.onMediaItemTransition(next.currentMediaItem, Player.MEDIA_ITEM_TRANSITION_REASON_SEEK)
    }

    /**
     * The old player after a hand-over: still heard (a hand-over before its end, for an edit:
     * Crossfader.settle), it fades out over [LET_GO_MS] first; then it goes, and its audio focus
     * with it, to [next]: asked for after the old one let go of it, as Android would otherwise take
     * it from the old one with a loss that pauses it. Never inside the old one's own callback (the
     * hand-over may come from its stop at the end).
     */
    private fun letGo(old: ExoPlayer, next: ExoPlayer) {
        val from = old.volume
        val steps = if (old.isPlaying && from > 0.01f) LET_GO_STEPS else 0
        var done = 0
        val step = object : Runnable {
            override fun run() {
                if (done < steps && !destroying) {
                    done++
                    old.volume = from * (1f - done.toFloat() / steps)
                    handler.postDelayed(this, LET_GO_MS / LET_GO_STEPS)
                    return
                }
                old.release()
                if (player === next) next.setAudioAttributes(audioAttributes, /* handleAudioFocus = */ true)
            }
        }
        handler.post(step)
    }

    /**
     * [next]'s list made [old]'s, around the track [next] plays (Crossfader drops a fade whose
     * track is no longer [old]'s next): edits during a fade went to [old]. Nothing is replaced
     * when nothing changed, and the playing track never is.
     */
    private fun bringInStep(old: ExoPlayer, next: ExoPlayer) {
        val n = old.mediaItemCount
        val items = List(n) { old.getMediaItemAt(it) }
        val same = n == next.mediaItemCount && items.indices.all { items[it] === next.getMediaItemAt(it) }
        if (!same) {
            val at = crossfadeTarget(old)
            val cur = next.currentMediaItemIndex
            if (at != C.INDEX_UNSET && at < n) {
                next.replaceMediaItems(cur + 1, next.mediaItemCount, items.subList(at + 1, n))
                next.replaceMediaItems(0, cur, items.subList(0, at))
            }
        }
        next.repeatMode = old.repeatMode
        next.shuffleModeEnabled = old.shuffleModeEnabled
        if (old.shuffleOrder.length == next.mediaItemCount) next.setShuffleOrder(old.shuffleOrder)
    }

    /**
     * A fade stopped before the hand-over: the incoming player goes, and the service's plays on
     * past its track's end as usual.
     */
    private fun dropIncoming() {
        val built = incoming ?: return
        incoming = null
        val next = built.player
        incomingEvents?.let { next.removeListener(it) }
        next.volume = 0f
        // Not inside its own callback (a drop may come from its error); at once when the service
        // ends, before the gate opens (its loader may wait there for the track after next).
        if (destroying) next.release() else handler.post { next.release() }
        player?.pauseAtEndOfMediaItems = false
        updateLoadAhead()
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
            stopOutageRetry()
            pauseAllPlayersAndStopSelf()
        }
    }

    override fun onDestroy() {
        Log.i(TAG, "PlaybackService destroyed")
        destroying = true
        // The latest list and position, before the player goes.
        if (sessionDirty) saveSessionNow()
        savePosition()
        handler.removeCallbacks(saveSession)
        handler.removeCallbacks(savePositionTick)
        lastSession.close()
        handler.removeCallbacks(prefetchCheck)
        handler.removeCallbacks(lowCheck)
        handler.removeCallbacks(blockEnded)
        handler.removeCallbacks(transitionDeadline)
        stopOutageRetry()
        NetBlock.remove(blockListener)
        NetBlock.cancelResume()
        releaseResumeWakeLock()
        if (noisyRegistered) {
            runCatching { unregisterReceiver(noisyReceiver) }
            noisyRegistered = false
        }
        radio.shutdown()
        StreamResolver.cancelPrefetch()
        likedSaver.stop()
        AudioCache.removeListener(likedSaver.cacheListener)
        AudioCache.removeLikedListener(likedSaver.likedListener)
        // The incoming player of a fade under way goes first, the main one below, and only then
        // the gate opens: a load waiting at it ends with the player instead of starting.
        crossfade?.release()
        crossfade = null
        if (networkCallbackRegistered) {
            try {
                connectivity().unregisterNetworkCallback(networkCallback)
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
        YtDataSpecResolver.gate.allow(emptySet())
        // The listening cache stays open for the process's life (AudioCache): nothing to release here.
        super.onDestroy()
    }

    // ---------------------------------------------------------------------------------------

    private inner class PlayerListener : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            val now = SystemClock.elapsedRealtime()
            // Playing, then stalled to fill the buffer again: not a seek's, a skip's or an edit's.
            val rebuffer = rebuffers.onState(
                ready = playbackState == Player.STATE_READY,
                buffering = playbackState == Player.STATE_BUFFERING,
                playWhenReady = player?.playWhenReady == true,
                now = now,
            )
            // Auto quality is about YouTube's streams: a slow latex.gg (a Jukebox MP3) doesn't count.
            if (rebuffer && !JukeUris.isMp3(player?.currentMediaItem)) governor.onRebuffer(now)
            when (playbackState) {
                Player.STATE_BUFFERING -> transitions.onBuffering(now)
                Player.STATE_READY -> judged(transitions.onReady(now))
                else -> {
                    transitions.cancel()
                    handler.removeCallbacks(transitionDeadline)
                }
            }
            // A stall stops a liked save; ready (or idle), one may start.
            likedSaver.check()
            if (playbackState == Player.STATE_ENDED) endedAt = now
            // Loading again (a restored session's first Play, or a retry): autoplay may top up.
            if (playbackState != Player.STATE_IDLE) {
                handler.removeCallbacks(lowCheck)
                handler.post(lowCheck)
            }
            if (playbackState == Player.STATE_READY) {
                consecutiveFailures = 0
                outagePauses = 0
                lastReadyId = player?.currentMediaItem?.mediaId
                player?.currentMediaItem?.mediaId?.let { expiredRetried.remove(it) }
                // No NetBlock.success() here: READY from a cached URL or buffered bytes proves
                // nothing about YouTube; a successful extraction or InnerTube request does (M1).
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying) {
                // Its stream works (also after a gapless move to it, which has no READY).
                lastReadyId = player?.currentMediaItem?.mediaId
                // Playing again: an outage's tries are over, and nothing waits for the network
                // (Play pressed during the wait: the wait goes, and says so).
                stopOutageRetry()
                if (BackOffHold.playingSpendsResume(NetBlock.waitingForNetwork(), NetBlock.isBlocked(), JukeUris.isMp3(player?.currentMediaItem))) {
                    NetBlock.takeResume()
                }
            }
            schedulePrefetch()
            // Where it stopped, and while it plays every few seconds (a crash loses no more).
            handler.removeCallbacks(savePositionTick)
            savePosition()
            if (isPlaying) handler.postDelayed(savePositionTick, POSITION_SAVE_MS)
        }

        /** Loading started or stopped: the liked saver looks again (it goes by [PlaybackNeed]). */
        override fun onIsLoadingChanged(isLoading: Boolean) {
            likedSaver.check()
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            // Our own pause (pauseToResume) arrives here after it returned (Media3 queues events
            // raised inside onPlayerError): it must not cancel the resume it asked for.
            if (!playWhenReady && ownPause) {
                ownPause = false
                return
            }
            // A pause outside a back-off is the user's: nothing to resume later. (During one,
            // a refused play the plugin turned into a pause keeps its resume; an MP3 plays
            // through a back-off, so its pause is the user's.)
            if (!playWhenReady && BackOffHold.pauseIsUsers(NetBlock.isBlocked(), JukeUris.isMp3(player?.currentMediaItem))) {
                NetBlock.cancelResume()
                releaseResumeWakeLock()
                stopOutageRetry()
            }
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int,
        ) {
            schedulePrefetch()
            // A seek, a skip or a removal: the buffering it causes is no rebuffer.
            if (reason != Player.DISCONTINUITY_REASON_AUTO_TRANSITION) rebuffers.onJump(SystemClock.elapsedRealtime())
            if (reason == Player.DISCONTINUITY_REASON_SEEK) savePosition()
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            queue.onTransition()
            // Not in repeat all's loop: it would lose its songs lap after lap.
            val trimmed = if (player?.repeatMode != Player.REPEAT_MODE_ALL) queue.trimPlayedAuto(QueueCommands.KEEP_PLAYED_AUTO) else 0
            if (trimmed > 0) Log.i(TAG, "Trimmed $trimmed played autoplay item(s)")
            queueChanged()
            // A skip makes any pending prefetch for the old "next" stale.
            StreamResolver.cancelPrefetch()
            prefetchedKey = null
            Log.i(TAG, "Transition to ${mediaItem?.mediaId} (${JukeUris.ytIdOf(mediaItem)}), reason=$reason")
            val now = SystemClock.elapsedRealtime()
            // A skip is a jump; so is a track ending with the next not buffered ahead (Gapless off): it starts cold.
            rebuffers.onTransition(
                auto = reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO,
                nextReadied = LoadAhead.wanted(gapless, crossfadeMs),
                now = now,
            )
            // A track ended by itself: was the move seamless? (The crossfade's hand-over is a seek: not judged.)
            handler.removeCallbacks(transitionDeadline)
            if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) {
                transitions.onAutoTransition(now, player?.playbackState == Player.STATE_BUFFERING)
                handler.postDelayed(transitionDeadline, TransitionWatch.WINDOW_MS)
            } else {
                transitions.cancel()
            }
            // Moved on gaplessly, already playing: no READY comes for this one.
            if (player?.playbackState == Player.STATE_READY) lastReadyId = mediaItem?.mediaId
            failureSpot.clear()
            StreamResolver.releaseFormats()
            governQuality(mediaItem)
            schedulePrefetch()
        }

        override fun onPlayerError(error: PlaybackException) {
            // A release that timed out in onDestroy reports it here, listeners still attached:
            // there is no track to skip or pause any more.
            if (destroying) return
            val p = player ?: return
            handlePlayerError(p, error)
        }

        override fun onTimelineChanged(timeline: Timeline, reason: Int) {
            if (reason != Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) return
            queue.onPlaylistChanged()
            queueChanged()
            schedulePrefetch()
            // Once the queue has arranged the edit (a shuffled insert first lands anywhere): the
            // crossfade looks at the next track (CrossfadeEvents leaves edits to us).
            crossfade?.onListChanged()
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
            crossfade?.onListChanged()
            updateModeButtons()
        }

        /** Repeat all loops what you started ([NativeQueue.onRepeatModeChanged]); off again, autoplay fills up. */
        override fun onRepeatModeChanged(repeatMode: Int) {
            queue.onRepeatModeChanged(repeatMode == Player.REPEAT_MODE_ALL)
            lowKey = null
            queueChanged()
            updateModeButtons()
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
        // The prefetch thread is the liked saver's too: playback's link comes first.
        if (StreamResolver.prefetch(ytId)) likedSaver.giveWay()
    }

    // ---- Auto quality ---------------------------------------------------------------------------

    /**
     * A track started: Auto's rung for the tracks resolved from now on (one step at most, from
     * this track's ladder and the rebuffers so far). This track keeps the format it has.
     */
    private fun governQuality(item: MediaItem?) {
        val quality = StreamResolver.quality
        // The user changed the setting since the last track: probing starts over.
        if (quality != governedQuality) {
            governedQuality = quality
            governor.onSettingChanged()
        }
        // A Jukebox MP3 has one fixed file: no rung to pick, and it doesn't count as a track at a rung.
        if (quality != AudioQuality.AUTO || JukeUris.isMp3(item)) return
        val ladder = JukeUris.ytIdOf(item)?.let { StreamResolver.lastServed(it) }?.ladderBps ?: emptyList()
        val before = StreamResolver.autoRung
        val rung = governor.onTrackStarted(SystemClock.elapsedRealtime(), ladder)
        StreamResolver.autoRung = rung
        if (rung != before) Log.i(TAG, "Auto quality: rung ${before + 1} -> ${rung + 1}")
    }

    // ---- "Add to queue" (play next, FIFO) ----------------------------------------------------

    private fun queueNext(items: List<MediaItem>) {
        // During a fade, after the track fading in: it takes over first.
        crossfade?.settle()
        val at = queue.queueNext(items)
        if ((player?.mediaItemCount ?: 0) > 0) Log.i(TAG, "queueNext: ${items.size} item(s) at $at, ${queue.pendingSerials.size} pending")
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
        val p = player ?: return
        if (!Stations.keepsGoing(autoplayEnabled, seedId, context?.first) || forSeed != seedId || !Stations.mayAutoplay(p.repeatMode, p.mediaItemCount)) {
            Log.i(TAG, "addAutoplay: ${items.size} item(s) dropped (stale or autoplay off)")
            return
        }
        queue.addAutoplay(items)
        Log.i(TAG, "addAutoplay: ${items.size} item(s), ${queue.ahead()} ahead")
        queueChanged()
    }

    private fun setAutoplay(enabled: Boolean) {
        if (enabled == autoplayEnabled) return
        autoplayEnabled = enabled
        PlayerPrefsStore.setAutoplay(this, enabled)
        lowKey = null
        if (!enabled) {
            radio.stop()
            // A station's next rounds stay (Stations.keepsGoing).
            if (!Stations.keepsGoing(false, seedId, context?.first)) queue.dropUpcomingAuto()
        }
        queueChanged()
    }

    /** The Crossfade setting (validated): saved, and in use at once (a change stops a fade under way). */
    private fun setCrossfade(ms: Int) {
        PlayerPrefsStore.setCrossfadeMs(this, ms)
        crossfadeMs = ms
        crossfade?.setSetting(ms)
        // Crossfade readies the next track early too (LoadAhead.wanted): with Gapless off, the setting decides the load-ahead.
        updateLoadAhead()
    }

    /** The Gapless playback setting: saved, and the load-ahead follows it at once. */
    private fun setGapless(enabled: Boolean) {
        PlayerPrefsStore.setGapless(this, enabled)
        gapless = enabled
        updateLoadAhead()
    }

    /** A tap in Up next: on an autoplay item the radio continues from it. */
    private fun skipTo(p: ExoPlayer, index: Int) {
        resetFailures()
        if (queue.skipTo(index)) reseed(p.currentMediaItem) else queueChanged()
    }

    private fun resetFailures() {
        consecutiveFailures = 0
        outagePauses = 0
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
        if (section == NativeQueue.Section.AUTO && !Stations.keepsGoing(autoplayEnabled, seedId, context?.first)) {
            Log.i(TAG, "restore: autoplay item dropped (autoplay off)")
            return
        }
        // During a fade, among the tracks after the one fading in: it takes over first.
        crossfade?.settle()
        queue.restore(item, section, beforeId)
        queueChanged()
    }

    /** Publishes the queue facts for the plugin's state and checks autoplay (posted, once). */
    private fun queueChanged() {
        updateLoadAhead()
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

    /** Debug builds only (R8 strips info logs from the others; no ids): how a track's own end went. */
    private fun judged(v: TransitionWatch.Verdict?) {
        when (v) {
            null -> return
            TransitionWatch.Verdict.Seamless -> Log.i(TAG, "Transition seamless")
            is TransitionWatch.Verdict.Stalled -> Log.i(TAG, "Transition stalled: ${v.gapMs} ms")
        }
        handler.removeCallbacks(transitionDeadline)
    }

    /** Tells the load control which items play now and next (in play order: shuffle, repeat). */
    private fun updateLoadAhead() {
        val lc = oneAhead ?: return
        val p = player
        if (p == null || p.mediaItemCount == 0) {
            lc.currentIndex = C.INDEX_UNSET
            lc.nextIndex = C.INDEX_UNSET
            loadingIds = emptySet()
            YtDataSpecResolver.gate.allow(emptySet())
            return
        }
        // With Gapless off and no crossfade, the next track loads no further than its preparation
        // until it is current (LoadAhead): ExoPlayer still moves on to it by itself. During a fade
        // the incoming player loads it, not this one.
        val next = p.nextMediaItemIndex
        lc.nextIndex = if (incoming != null) C.INDEX_UNSET else LoadAhead.nextToLoad(LoadAhead.wanted(gapless, crossfadeMs), next)
        lc.currentIndex = p.currentMediaItemIndex
        // The pair may open its stream (the next one must prepare, whether it loads ahead or not);
        // the item after next, prepared early, waits.
        // By audio id: a Jukebox MP3 waits its turn too, and two MP3s in a row must not leave the
        // pair empty (which lets everything through). The liked saver knows them by it as well.
        val ids = HashSet<String>(2)
        JukeUris.audioIdOf(p.currentMediaItem)?.let { ids.add(it) }
        if (next != C.INDEX_UNSET) JukeUris.audioIdOf(p.getMediaItemAt(next))?.let { ids.add(it) }
        loadingIds = ids
        // During a crossfade the incoming player's track is this one's next: in the pair.
        YtDataSpecResolver.gate.allow(ids)
        // Another pair to load (a skip, a new list): the liked saver looks again.
        likedSaver.check()
    }

    /**
     * AP4: with 5 items or fewer to go (any kind, as InnerTune's "load more"), get more. A Global radio is refilled here;
     * Jukebox picks come from the web side (`queueLow`). Nothing with autoplay off, or with repeat
     * all but for a single song ([Stations.mayAutoplay]).
     */
    private fun checkLow() {
        val p = player ?: return
        // Nothing loading (a restored session before its first Play): no requests for more yet.
        val idle = p.playbackState == Player.STATE_IDLE && !p.playWhenReady
        if (!Stations.keepsGoing(autoplayEnabled, seedId, context?.first) || !Stations.mayAutoplay(p.repeatMode, p.mediaItemCount) || p.mediaItemCount == 0 || seedId == null || idle) {
            lowKey = null
            QueueInfo.clearLow()
            return
        }
        val left = queue.ahead()
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
        radio.reseedFromId(s.seedId)
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
            JukeTracks.toMediaItem(e.toNativeTrack(), restored = true)
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
            val serial = extras?.getLong(QueueCommands.EXTRA_QUEUE_SERIAL, 0L) ?: 0L
            val extra = TrackExtras.get(item.mediaId)
            val ytId = JukeUris.ytIdOf(item)
            val mp3 = if (ytId == null) JukeUris.mp3UrlOf(item) ?: return null else null
            entries.add(
                LastSession.Entry(
                    id = item.mediaId,
                    ytId = ytId ?: "",
                    mp3 = mp3,
                    title = item.mediaMetadata.title?.toString(),
                    artist = item.mediaMetadata.artist?.toString(),
                    artworkUrl = item.mediaMetadata.artworkUri?.toString(),
                    by = extra?.by,
                    postUrl = extra?.postUrl,
                    membersOnly = extra?.membersOnly == true,
                    album = item.mediaMetadata.albumTitle?.toString(),
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
            queueHost.shuffleOrder(), p.repeatMode, context, seedId, System.currentTimeMillis(),
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
        val ioOther = error.errorCode == PlaybackException.ERROR_CODE_IO_UNSPECIFIED ||
            error.findCause<EOFException>() != null || error.findCause<SocketException>() != null
        val isCurrent = index == p.currentMediaItemIndex
        val positionMs = if (isCurrent) p.currentPosition.coerceAtLeast(0L) else 0L
        val known = TrackErrorPolicy.Facts(
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
            ioOther = ioOther,
            networkValidated = isNetworkValidated(),
            playedThisItem = trackId == lastReadyId,
            isCurrent = isCurrent,
            hasNext = p.hasNextMediaItem(),
            consecutiveFailures = consecutiveFailures,
            outagePauses = outagePauses,
            mp3 = JukeUris.isMp3(item),
        )
        // A track broken at one spot fails there again after each resume (READY in between).
        // Counted only where the unclear failure decides (not a connection failure, say).
        val facts = if (TrackErrorPolicy.countsAtSpot(known)) {
            known.copy(failuresHere = failureSpot.onFailure(trackId, positionMs))
        } else {
            known
        }
        val message = resolve?.message
            ?: http?.let { "HTTP ${it.responseCode}: ${error.errorCodeName}" }
            ?: "${error.errorCodeName}: ${error.message ?: error.cause?.message ?: "unknown error"}"
        val action = TrackErrorPolicy.decide(facts)
        Log.w(TAG, "Player error ${error.errorCodeName} -> ${action.javaClass.simpleName}")
        // Paused on a track that was playing: when it loads again (from byte 0, so not a
        // mid-stream load), it keeps its format, whatever Auto's rung says by then.
        if (TrackErrorPolicy.keepsFormat(action, isCurrent, facts.playedThisItem, positionMs)) {
            ytId?.let { StreamResolver.keepFormat(it) }
        }

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
                    perVideoFailure(p, index, trackId, ytId, message, error, TrackErrorPolicy.perVideo(facts))
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
                    perVideoFailure(p, index, trackId, ytId, message, error, TrackErrorPolicy.perVideo(facts))
                    return
                }
                // Expired URL (or a new network address, or a refusal): same itag, same position.
                Log.i(TAG, "HTTP ${http?.responseCode} for $trackId: re-resolving once")
                reResolveAndRetry(p, index, item, trackId, ytId)
            }
            is TrackErrorPolicy.Action.Pause -> {
                Log.i(TAG, "TRACK_ERROR $trackId (yt=$ytId), pausing: $message")
                if (action.freshLink) ytId?.let { StreamResolver.reResolve(it) }
                if (action.resume) {
                    outagePauses++
                    pauseToResume(p) // back when the network is
                } else {
                    p.pause()
                }
                PlayerBus.emitTrackError(trackId, message, false, network = action.network, resumes = action.resume)
            }
            TrackErrorPolicy.Action.Skip, TrackErrorPolicy.Action.PauseAtEnd, TrackErrorPolicy.Action.Stop ->
                perVideoFailure(p, index, trackId, ytId, message, error, action)
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
        NetBlock.wantResume(outage = !afterBlock)
        if (!afterBlock) {
            // An outage: back when the network is validated again, or on the next try while
            // it stays validated (a weak link).
            resumeSchedule.onOutagePause(SystemClock.elapsedRealtime())
            armOutageRetry()
            return
        }
        stopOutageRetry()
        // The resume's timer and wake lock, now that it is wanted. A back-off that already
        // ran out by the time its error surfaced (at a track change): try again at once.
        val until = NetBlock.active().first
        if (until > 0L) scheduleResume(until) else handler.post { resumeAfterBlock() }
    }

    /**
     * The next outage try, or the window's end (one pending at most), with the phone kept awake
     * until then: on a weak link that stays validated no network callback wakes it, so a locked
     * phone would make the try wait for the screen to come on.
     */
    private fun armOutageRetry() {
        handler.removeCallbacks(outageRetry)
        val delay = resumeSchedule.delayMs(SystemClock.elapsedRealtime()) ?: return endOutageWait()
        handler.postDelayed(outageRetry, delay)
        keepAwakeFor(delay)
    }

    /** The window is over: the wait is given up (the page hears it, Play still works). */
    private fun endOutageWait() {
        handler.removeCallbacks(outageRetry)
        resumeSchedule.stop()
        if (NetBlock.waitingForNetwork()) {
            Log.i(TAG, "Network still not back: no longer resuming by itself")
            NetBlock.cancelResume()
        }
    }

    /**
     * An outage try: with a validated network, resume (resumeAfterBlock's checks apply: other
     * audio, headphones gone, Android 12+ background start). A new outage pause arms the next
     * try; without a validated network the callback resumes, and the try after it is armed.
     */
    private fun retryAfterOutage() {
        if (!NetBlock.waitingForNetwork()) {
            resumeSchedule.stop()
            return
        }
        val now = SystemClock.elapsedRealtime()
        if (resumeSchedule.isOver(now)) {
            endOutageWait()
            return
        }
        resumeSchedule.attempted(now)
        if (isNetworkValidated()) {
            Log.i(TAG, "Outage: trying again")
            lastNetResumeAt = now
            resumeAfterBlock()
            // Refused (another app playing, headphones gone, background): the tries are over.
            if (!NetBlock.waitingForNetwork() && player?.playWhenReady != true) resumeSchedule.stop()
        }
        if (NetBlock.waitingForNetwork()) armOutageRetry()
    }

    private fun stopOutageRetry() {
        handler.removeCallbacks(outageRetry)
        resumeSchedule.stop()
        // A back-off's resume that is still wanted takes it again (pauseToResume, scheduleResume).
        releaseResumeWakeLock()
    }

    /** A real per-video failure: [action] is TrackErrorPolicy's Skip, PauseAtEnd or Stop. */
    private fun perVideoFailure(
        p: ExoPlayer,
        index: Int,
        trackId: String,
        ytId: String?,
        message: String,
        error: PlaybackException,
        action: TrackErrorPolicy.Action,
    ) {
        consecutiveFailures++
        // Ids only at info level (stripped from release builds); the warning has none.
        Log.i(TAG, "TRACK_ERROR $trackId (yt=$ytId), failure #$consecutiveFailures: $message")
        Log.w(TAG, "Track failed (#$consecutiveFailures): ${error.errorCodeName}")
        expiredRetried.remove(trackId)

        when {
            action == TrackErrorPolicy.Action.Stop -> {
                Log.w(TAG, "Stopping after $consecutiveFailures consecutive failures")
                consecutiveFailures = 0
                PlayerBus.emitTrackError(
                    trackId,
                    "Stopped after ${TrackErrorPolicy.MAX_CONSECUTIVE_FAILURES} tracks failed in a row. Last error: $message",
                    false,
                )
                p.pause()
            }
            action == TrackErrorPolicy.Action.PauseAtEnd -> {
                // Nothing after it: stay on the failed item, paused. play() retries it.
                p.pause()
                PlayerBus.emitTrackError(trackId, message, false)
            }
            index == p.currentMediaItemIndex -> {
                // Normal case (ExoPlayer reports load errors for the playing item): skip it and
                // keep the list unchanged, so indices on the web side stay valid.
                p.seekToNextMediaItem()
                p.prepare()
                PlayerBus.emitTrackError(trackId, message, true)
            }
            else -> {
                // A different (upcoming) item failed: drop it, otherwise re-preparing would hit
                // the same error again while the current item plays.
                p.removeMediaItem(index)
                p.prepare()
                PlayerBus.emitTrackError(trackId, message, true)
            }
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
         * A pause or stop key while already paused changes nothing in the player, so nothing
         * else hears it: a resume waiting for a back-off to end is cancelled here (the user
         * wants it quiet), and the key is then handled as usual. A headset's play/pause while
         * an outage waits is the app's Pause ([BackOffHold.keyStopsWait]): it calls the resume
         * off and goes no further, since Media3 would play.
         */
        override fun onMediaButtonEvent(
            session: MediaSession,
            controllerInfo: MediaSession.ControllerInfo,
            intent: Intent,
        ): Boolean {
            // The untyped getter: the typed one is unreliable on Android 13 (androidx IntentCompat
            // avoids it there too), and a media key must never crash the service.
            val key = try {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT)
            } catch (e: Exception) {
                null
            }
            if (key == null || key.action != KeyEvent.ACTION_DOWN || !NetBlock.resumePending()) return false
            val fromNotification = session.isMediaNotificationController(controllerInfo)
            if (!BackOffHold.keyStopsWait(key.keyCode, NetBlock.waitingForNetwork(), fromNotification)) return false
            Log.i(TAG, "Pause key while a resume was pending: cancelled")
            NetBlock.cancelResume()
            releaseResumeWakeLock()
            stopOutageRetry()
            return key.keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || key.keyCode == KeyEvent.KEYCODE_HEADSETHOOK
        }

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
            val ours = QueueCommands.ALL.any { it.customAction == action }
            if (!ours || !isPlugin(session, controller)) {
                return super.onCustomCommand(session, controller, customCommand, args)
            }
            val p = player ?: return Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
            fun tracks(): List<MediaItem>? = try {
                JukeTracks.parse(JSONArray(args.getString(QueueCommands.ARG_TRACKS) ?: "[]"))
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
                    QueueCommands.ACTION_QUEUE_NEXT -> queueNext(tracks() ?: return bad)
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
                    QueueCommands.ACTION_SET_CROSSFADE -> setCrossfade(
                        CrossfadePlan.valid(args.getInt(QueueCommands.ARG_MS, -1)) ?: return bad,
                    )
                    QueueCommands.ACTION_SET_GAPLESS -> setGapless(args.getBoolean(QueueCommands.ARG_ENABLED, true))
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
         * fetch an arbitrary URL or read a local file. Artwork only from what
         * [SessionPolicy.isAllowedArtwork] allows. Items without a valid id are dropped; so are
         * Jukebox MP3s, which only the page hands in.
         */
        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<MutableList<MediaItem>> {
            val ciTone = if (isPlugin(mediaSession, controller) && isDebuggable()) LaunchOptions.CI_TONE else null
            val restored = mediaItems.mapNotNull { item -> sanitize(item, ciTone) }.toMutableList()
            if (restored.size != mediaItems.size) {
                Log.w(TAG, "Dropped ${mediaItems.size - restored.size} item(s) without a valid video id (MP3s are never taken from a controller)")
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
            packageNameVerified = controller.isPackageNameVerified,
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

        /** A crossfade's old player, still heard at a hand-over (an edit's), fades out over this long, */
        private const val LET_GO_MS = 250L

        /** in this many steps. */
        private const val LET_GO_STEPS = 5
    }
}
