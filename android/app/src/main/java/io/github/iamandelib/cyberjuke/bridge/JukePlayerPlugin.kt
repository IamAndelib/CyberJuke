package io.github.iamandelib.cyberjuke.bridge

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionToken
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.common.util.concurrent.ListenableFuture
import io.github.iamandelib.cyberjuke.net.BlockReason
import io.github.iamandelib.cyberjuke.net.Families
import io.github.iamandelib.cyberjuke.net.Family
import io.github.iamandelib.cyberjuke.net.Ipv4Mode
import io.github.iamandelib.cyberjuke.net.NetBlock
import io.github.iamandelib.cyberjuke.net.NetPrefs
import io.github.iamandelib.cyberjuke.playback.BridgeLimits
import io.github.iamandelib.cyberjuke.playback.ControllerKey
import io.github.iamandelib.cyberjuke.playback.JukeCommands
import io.github.iamandelib.cyberjuke.playback.JukeTracks
import io.github.iamandelib.cyberjuke.playback.JukeUris
import io.github.iamandelib.cyberjuke.playback.LaunchOptions
import io.github.iamandelib.cyberjuke.playback.NativeQueue
import io.github.iamandelib.cyberjuke.playback.NetPrefsStore
import io.github.iamandelib.cyberjuke.playback.PlaybackService
import io.github.iamandelib.cyberjuke.playback.PlayerBus
import io.github.iamandelib.cyberjuke.playback.QueueCommands
import io.github.iamandelib.cyberjuke.playback.QueueInfo
import io.github.iamandelib.cyberjuke.playback.StreamResolver
import io.github.iamandelib.cyberjuke.playback.TooLargeException
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * Capacitor bridge to PlaybackService. Contract (TS side):
 *   setQueue, addItems, queueNext, removeItem, moveItem, play, pause, seekTo, skipToNext,
 *   skipToPrevious, skipToIndex, setShuffle, setRepeat, setQuality, getState,
 *   getLaunchOptions, getBlockState, setNetworkPrefs, retryNow, getNetStatus,
 *   setGestureExclusion, addAutoplay,
 *   setAutoplay, restore, removeIds; events 'state', 'trackError', 'blocked', 'unblocked', 'extractorBroken',
 *   'queueLow', 'tracks'.
 *
 * - setQueue keeps the tracks queued with queueNext next (P1) and starts autoplay over from
 *   the started track (a Global one gets its radio natively, refilled in the service).
 * - state also carries `upNextKinds` (one letter per upNextIds entry: q = queued by you,
 *   l = the list, a = autoplay), `upNextIndex` (K1: each entry's index in the list, always
 *   sent), `context` ({ label, mode } or null) and `seedId`.
 * - skipToIndex, removeItem and moveItem take an optional `expectId` (K2: the id the caller
 *   sees at `index` / `from`); if the item there has another id the call rejects with code
 *   STALE_INDEX and nothing changes. Checked in the service, on the player itself.
 * - restore({ track, kind: 'queued' | 'list' | 'autoplay', beforeId }) (K3): Undo of a
 *   removal, see [io.github.iamandelib.cyberjuke.playback.NativeQueue.restore].
 * - removeIds({ ids }) (K5): removes every item with one of these ids; if the current one
 *   goes, the next one that stays plays, or playback pauses when none is left.
 * - Size caps (K6): more than 2000 tracks or ids, or a string over 2000 characters, rejects
 *   with code TOO_LARGE.
 * - queueLow { left, seedId }: autoplay has `left` (<= 5) Jukebox tracks to go: the web side
 *   computes more and sends them with addAutoplay({ tracks, seedId }).
 * - tracks { tracks: NativeTrack[] }: autoplay items the service added itself (Global radio),
 *   so the web side can show them; sent again after a resume or a new state listener.
 *
 * - state: NativeState. Sent on every player event and once a second while playing and the
 *   app is in the foreground (no ticks in the background). `queueIds` is only included when
 *   the list changed since the last event; otherwise it is left out and
 *   `queueIdsUnchanged: true` is set. getState() always includes it.
 * - blocked { until: epoch ms, reason: 'BOT_CHECK' | 'RATE_LIMIT' | 'STREAM_FORBIDDEN' }: YouTube
 *   is backing us off (see [NetBlock]); sent when a back-off starts or is extended, and again
 *   when play()/setQueue is refused during one. unblocked {}: the back-off ran out or was lifted
 *   (new network, IPv4 setting changed, retryNow), or playback worked again.
 *   extractorBroken { message }: YouTube changed something (parse failure).
 * - While blocked, setQueue/play still update the queue but do not prepare (no extraction):
 *   playback stays paused with isBuffering false. Once the back-off ends, the service resumes
 *   playback it stopped (or a play() it refused), within NetBlock.RESUME_WINDOW_MS.
 *
 * Threading: plugin methods arrive on Capacitor's background thread. Everything that
 * touches the MediaController is posted to the main thread; calls made before the
 * controller is connected are queued and run once it is.
 */
@CapacitorPlugin(name = "JukePlayer")
class JukePlayerPlugin : Plugin() {

    private val main = Handler(Looper.getMainLooper())
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private val pending = ArrayList<Pair<PluginCall, (MediaController) -> Unit>>()

    /** The host activity is in the foreground (between handleOnResume and handleOnPause). */
    private var foreground = true

    /** The list changed since `queueIds` was last sent (or the web needs it again). */
    private var queueDirty = true
    private var lastQueueIds: List<String>? = null

    /** A `blocked` event was sent and no `unblocked` since. */
    private var announcedBlock = false

    /** handleOnDestroy ran: no new controller, calls reject (L8). Main thread after the first. */
    @Volatile
    private var destroyed = false

    /** Autoplay items already described to the web in a `tracks` event. */
    private val announcedTracks = HashSet<String>()

    private val queueLowListener = QueueInfo.QueueLowListener { left, seedId ->
        main.post {
            val data = JSObject()
            data.put("left", left)
            data.put("seedId", seedId ?: JSONObject.NULL)
            notifyListeners("queueLow", data)
        }
    }

    private val ticker = object : Runnable {
        override fun run() {
            val c = controller ?: return
            // The CI smoke test counts these (debug builds; R8 strips Log.v from release).
            Log.v(TICK_TAG, "tick")
            emitState(c)
            if (c.isPlaying && foreground) main.postDelayed(this, TICK_MS)
        }
    }

    private fun restartTicker(c: MediaController) {
        main.removeCallbacks(ticker)
        if (c.isPlaying && foreground) main.postDelayed(ticker, TICK_MS)
    }

    private val playerListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            val c = controller ?: return
            if (events.contains(Player.EVENT_TIMELINE_CHANGED)) {
                queueDirty = true
                announceTracks(c)
            }
            emitState(c)
            if (events.contains(Player.EVENT_IS_PLAYING_CHANGED)) restartTicker(c)
        }
    }

    private val blockListener = object : NetBlock.Listener {
        override fun onBlocked(until: Long, reason: BlockReason) {
            main.post { announceBlocked(until, reason) }
        }

        override fun onUnblocked() {
            main.post { announceUnblocked() }
        }
    }

    private val unblockTimer = Runnable {
        if (!NetBlock.isBlocked()) announceUnblocked()
    }

    /** Called on loader and JukeMusic threads: notify from the main thread like the others. */
    private val brokenListener = PlayerBus.ExtractorBrokenListener { message ->
        main.post {
            val data = JSObject()
            data.put("message", message)
            notifyListeners("extractorBroken", data)
        }
    }

    private val trackErrorListener = PlayerBus.TrackErrorListener { trackId, message, skipped ->
        val data = JSObject()
        data.put("trackId", trackId)
        data.put("message", message)
        data.put("skipped", skipped)
        notifyListeners("trackError", data)
    }

    override fun load() {
        NetPrefsStore.load(context)
        PlayerBus.add(trackErrorListener)
        PlayerBus.addBroken(brokenListener)
        NetBlock.add(blockListener)
        QueueInfo.addLow(queueLowListener)
        main.post {
            val (until, reason) = NetBlock.active()
            if (reason != null) announceBlocked(until, reason)
            connect()
        }
    }

    override fun handleOnPause() {
        super.handleOnPause()
        main.post {
            foreground = false
            main.removeCallbacks(ticker)
        }
    }

    override fun handleOnResume() {
        super.handleOnResume()
        main.post {
            foreground = true
            val c = controller ?: return@post
            // Background events may have been throttled by the WebView: send everything once.
            queueDirty = true
            lastQueueIds = null
            announcedTracks.clear()
            announceTracks(c)
            emitState(c)
            restartTicker(c)
        }
    }

    /**
     * A new 'state' listener (e.g. the web reloaded) gets the full queue on the next event. A
     * new 'state' or 'tracks' listener gets the radio tracks again (K4): whichever registers
     * last, the `tracks` event reaches it.
     */
    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    override fun addListener(call: PluginCall) {
        super.addListener(call)
        val event = call.getString("eventName")
        if (event == "state" || event == "tracks") {
            main.post {
                if (event == "state") {
                    queueDirty = true
                    lastQueueIds = null
                }
                announcedTracks.clear()
                controller?.let { announceTracks(it) }
            }
        }
    }

    override fun handleOnDestroy() {
        destroyed = true
        PlayerBus.remove(trackErrorListener)
        PlayerBus.removeBroken(brokenListener)
        NetBlock.remove(blockListener)
        QueueInfo.removeLow(queueLowListener)
        main.post {
            main.removeCallbacks(ticker)
            main.removeCallbacks(unblockTimer)
            controller?.removeListener(playerListener)
            controllerFuture?.let { MediaController.releaseFuture(it) }
            controllerFuture = null
            controller = null
            pending.forEach { (call, _) -> call.reject("Plugin destroyed") }
            pending.clear()
        }
    }

    // ---- connection (main thread only) ------------------------------------------------------

    private fun connect() {
        if (controllerFuture != null || destroyed) return
        val ctx: Context = context
        val token = SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))
        val futureRef = arrayOfNulls<ListenableFuture<MediaController>>(1)
        val future = MediaController.Builder(ctx, token)
            // Proves to PlaybackService that this is the plugin (the private queue commands).
            .setConnectionHints(ControllerKey.hints())
            .setListener(object : MediaController.Listener {
                override fun onDisconnected(controller: MediaController) {
                    // A late call for a controller already replaced must not drop the new one (L7).
                    if (controllerFuture !== futureRef[0]) return
                    Log.w(TAG, "MediaController disconnected")
                    onControllerLost()
                }
            })
            .buildAsync()
        futureRef[0] = future
        controllerFuture = future
        future.addListener({
            if (controllerFuture !== future) {
                // Replaced or destroyed meanwhile.
                MediaController.releaseFuture(future)
                return@addListener
            }
            val c = try {
                future.get()
            } catch (e: Exception) {
                Log.e(TAG, "MediaController connection failed", e)
                controllerFuture = null
                val failed = ArrayList(pending)
                pending.clear()
                failed.forEach { (call, _) -> call.reject("Player service unavailable: ${e.message}") }
                return@addListener
            }
            controller = c
            c.addListener(playerListener)
            val queued = ArrayList(pending)
            pending.clear()
            queued.forEach { (call, action) -> runAction(call, c, action) }
            maybePlayCiTone(c)
            queueDirty = true
            lastQueueIds = null
            emitState(c)
            restartTicker(c)
        }, ContextCompat.getMainExecutor(ctx))
    }

    /** CI only, see [LaunchOptions.CI_TONE]. */
    private fun maybePlayCiTone(c: MediaController) {
        if (LaunchOptions.autoplay != LaunchOptions.CI_TONE || LaunchOptions.ciToneConsumed) return
        LaunchOptions.ciToneConsumed = true
        Log.i(TAG, "CI: queueing bundled test tone")
        val item = MediaItem.Builder()
            .setMediaId(LaunchOptions.CI_TONE)
            .setUri(JukeUris.forYt(LaunchOptions.CI_TONE))
            .setMediaMetadata(
                MediaMetadata.Builder().setTitle("CI test tone").setArtist("CyberJuke").build(),
            )
            .build()
        c.setMediaItems(listOf(item))
        c.prepare()
        c.play()
    }

    private fun onControllerLost() {
        main.removeCallbacks(ticker)
        controller?.removeListener(playerListener)
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controllerFuture = null
        controller = null
    }

    private fun withController(call: PluginCall, action: (MediaController) -> Unit) {
        main.post {
            if (destroyed) {
                call.reject("Plugin destroyed")
                return@post
            }
            val c = controller
            if (c != null && c.isConnected) {
                runAction(call, c, action)
            } else {
                if (c != null) onControllerLost()
                pending.add(call to action)
                connect()
            }
        }
    }

    private fun runAction(call: PluginCall, c: MediaController, action: (MediaController) -> Unit) {
        try {
            action(c)
        } catch (e: Exception) {
            Log.w(TAG, "${call.methodName} failed: ${e.javaClass.simpleName}")
            call.reject(e.message ?: e.toString(), e)
        }
    }

    // ---- plugin methods -----------------------------------------------------------------------

    /**
     * `setQueue({ tracks, startIndex, positionMs?, playWhenReady, context?: { label, mode } })`:
     * a new list. Tracks queued with queueNext stay next (P1); autoplay starts over.
     */
    @PluginMethod
    fun setQueue(call: PluginCall) {
        val tracks = call.getArray("tracks") ?: return call.reject("tracks is required")
        val items = parseTracksOrReject(call, tracks) ?: return
        val startIndex = intArg(call, "startIndex") ?: 0
        val positionMs = longArg(call, "positionMs") ?: 0L
        val playWhenReady = call.getBoolean("playWhenReady", true) ?: true
        val ctx = call.getObject("context")
        val label = stringArg(call, ctx?.getString("label"), "context.label") ?: return
        Log.i(TAG, "BRIDGE setQueue n=${items.size}")
        withController(call) { c ->
            // An empty list goes through SET_LIST too: it clears the seed, radio and context (L4).
            val args = Bundle().apply {
                putString(QueueCommands.ARG_TRACKS, tracks.toString())
                putInt(QueueCommands.ARG_START, startIndex.coerceIn(0, (items.size - 1).coerceAtLeast(0)))
                putLong(QueueCommands.ARG_POSITION, positionMs.coerceAtLeast(0L))
                putString(QueueCommands.ARG_LABEL, label)
                putString(QueueCommands.ARG_MODE, ctx?.getString("mode") ?: "list")
            }
            sendCommand(call, c, QueueCommands.SET_LIST, args) {
                if (items.isEmpty()) {
                    // Nothing to load.
                } else if (refuseWhileBlocked(it)) {
                    // Queue updated, but no extraction until the back-off ends.
                } else {
                    it.playWhenReady = playWhenReady
                    it.prepare()
                    if (playWhenReady) maybeRequestNotificationPermission()
                }
                call.resolve()
            }
        }
    }

    /**
     * `addAutoplay({ tracks, seedId })`: Jukebox autoplay picks (after a `queueLow`) for the seed
     * they were computed for; dropped if the seed changed meanwhile, autoplay is off or repeat on.
     */
    @PluginMethod
    fun addAutoplay(call: PluginCall) {
        val tracks = call.getArray("tracks")
        val count = parseTracksOrReject(call, tracks)?.size ?: return
        stringArg(call, call.getString("seedId"), "seedId") ?: return
        if (count == 0) {
            call.resolve()
            return
        }
        val args = Bundle().apply {
            putString(QueueCommands.ARG_TRACKS, tracks.toString())
            putString(QueueCommands.ARG_SEED, call.getString("seedId"))
        }
        withController(call) { c -> sendCommand(call, c, QueueCommands.ADD_AUTOPLAY, args) }
    }

    /** `setAutoplay({ enabled })`: the Autoplay setting (C3). Off drops the autoplay tracks to come. */
    @PluginMethod
    fun setAutoplay(call: PluginCall) {
        val enabled = call.getBoolean("enabled") ?: return call.reject("enabled is required")
        val args = Bundle().apply { putBoolean(QueueCommands.ARG_ENABLED, enabled) }
        withController(call) { c -> sendCommand(call, c, QueueCommands.SET_AUTOPLAY, args) }
    }

    /** Sends a custom command to PlaybackService; [then] runs on success (default: resolve). */
    private fun sendCommand(
        call: PluginCall,
        c: MediaController,
        command: SessionCommand,
        args: Bundle,
        then: (MediaController) -> Unit = { call.resolve() },
    ) {
        val name = command.customAction.substringAfterLast('.')
        val future = c.sendCustomCommand(command, args)
        future.addListener({
            val result = try {
                future.get()
            } catch (e: Exception) {
                call.reject("$name failed: ${e.message}")
                return@addListener
            }
            if (result.resultCode == SessionResult.RESULT_SUCCESS) {
                runAction(call, c, then)
            } else {
                // STALE_INDEX or TOO_LARGE from the service, as the reject code.
                val code = result.extras.getString(QueueCommands.RESULT_CODE)
                if (code != null) {
                    call.reject("$name failed: $code", code)
                } else {
                    call.reject("$name failed: result ${result.resultCode}")
                }
            }
        }, ContextCompat.getMainExecutor(context))
    }

    @PluginMethod
    fun addItems(call: PluginCall) {
        val items = parseTracksOrReject(call, call.getArray("tracks")) ?: return
        val index = intArg(call, "index")
        withController(call) { c ->
            if (items.isNotEmpty()) {
                if (index == null) {
                    c.addMediaItems(items)
                } else {
                    c.addMediaItems(index.coerceIn(0, c.mediaItemCount), items)
                }
            }
            call.resolve()
        }
    }

    /**
     * "Add to queue": plays [tracks] right after the current item and after tracks queued
     * earlier (FIFO), then the original queue continues, also with shuffle on. Handled in
     * PlaybackService as a custom session command (see [JukeCommands.QUEUE_NEXT]).
     */
    @PluginMethod
    fun queueNext(call: PluginCall) {
        val tracks = call.getArray("tracks")
        // Validate here so bad input rejects with a clear message.
        val count = parseTracksOrReject(call, tracks)?.size ?: return
        if (count == 0) {
            call.resolve()
            return
        }
        val args = Bundle().apply { putString(JukeCommands.ARG_TRACKS, tracks.toString()) }
        withController(call) { c -> sendCommand(call, c, JukeCommands.QUEUE_NEXT, args) }
    }

    /** `removeItem({ index, expectId? })`: done in the service, which checks `expectId` (K2). */
    @PluginMethod
    fun removeItem(call: PluginCall) {
        val index = intArg(call, "index") ?: return call.reject("index is required")
        val expectId = stringArg(call, call.getString("expectId"), "expectId") ?: return
        withController(call) { c ->
            if (index !in 0 until c.mediaItemCount) {
                call.reject("index out of range: $index")
            } else {
                val args = Bundle().apply {
                    putInt(QueueCommands.ARG_INDEX, index)
                    putExpect(expectId)
                }
                sendCommand(call, c, QueueCommands.REMOVE, args)
            }
        }
    }

    /** `moveItem({ from, to, expectId? })`: `expectId` is the id at `from` (K2). */
    @PluginMethod
    fun moveItem(call: PluginCall) {
        val from = intArg(call, "from") ?: return call.reject("from is required")
        val to = intArg(call, "to") ?: return call.reject("to is required")
        val expectId = stringArg(call, call.getString("expectId"), "expectId") ?: return
        withController(call) { c ->
            val n = c.mediaItemCount
            if (from !in 0 until n || to !in 0 until n) {
                call.reject("index out of range: from=$from to=$to count=$n")
            } else {
                val args = Bundle().apply {
                    putInt(QueueCommands.ARG_FROM, from)
                    putInt(QueueCommands.ARG_TO, to)
                    putExpect(expectId)
                }
                sendCommand(call, c, QueueCommands.MOVE, args)
            }
        }
    }

    /**
     * `restore({ track, kind: 'queued' | 'list' | 'autoplay', beforeId: string | null })`: Undo
     * of a removal (K3). The track goes back into its section of Up next, right before the
     * first entry after the current track with id `beforeId` in that section, else at the end
     * of that section; never at or before the current track.
     */
    @PluginMethod
    fun restore(call: PluginCall) {
        val track = call.getObject("track") ?: return call.reject("track is required")
        val arr = JSONArray().put(track)
        parseTracksOrReject(call, arr) ?: return
        val kind = call.getString("kind")
        if (NativeQueue.Section.of(kind) == null) return call.reject("kind must be 'queued', 'list' or 'autoplay'")
        val beforeId = stringArg(call, call.getString("beforeId"), "beforeId") ?: return
        val args = Bundle().apply {
            putString(QueueCommands.ARG_TRACKS, arr.toString())
            putString(QueueCommands.ARG_KIND, kind)
            if (beforeId.isNotEmpty()) putString(QueueCommands.ARG_BEFORE, beforeId)
        }
        withController(call) { c -> sendCommand(call, c, QueueCommands.RESTORE, args) }
    }

    /**
     * `removeIds({ ids })` (K5, sign-out): removes every item with one of [ids]. If the current
     * item goes, the next one that stays plays; with none left, playback pauses.
     */
    @PluginMethod
    fun removeIds(call: PluginCall) {
        val ids = try {
            BridgeLimits.idsOf(call.getArray("ids") ?: return call.reject("ids is required"))
        } catch (e: TooLargeException) {
            return call.reject(e.message, QueueCommands.TOO_LARGE)
        } catch (e: Exception) {
            return call.reject("Invalid ids: ${e.message}")
        }
        if (ids.isEmpty()) return call.resolve()
        val args = Bundle().apply { putStringArrayList(QueueCommands.ARG_IDS, ArrayList(ids)) }
        withController(call) { c ->
            sendCommand(call, c, QueueCommands.REMOVE_IDS, args) {
                if (it.playbackState == Player.STATE_IDLE && it.mediaItemCount > 0 && it.playWhenReady &&
                    !NetBlock.isBlocked()
                ) {
                    it.prepare()
                }
                call.resolve()
            }
        }
    }

    @PluginMethod
    fun play(call: PluginCall) {
        withController(call) { c ->
            // A loaded item resumes from its cached stream; only a prepare (IDLE/ENDED) would
            // extract, and that waits for the back-off to end.
            val needsLoad = c.playbackState == Player.STATE_IDLE || c.playbackState == Player.STATE_ENDED
            if (c.mediaItemCount > 0 && !(needsLoad && refuseWhileBlocked(c))) {
                when (c.playbackState) {
                    Player.STATE_IDLE -> c.prepare()
                    Player.STATE_ENDED -> c.seekTo(c.currentMediaItemIndex, 0L)
                    else -> Unit
                }
                c.play()
                maybeRequestNotificationPermission()
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        // The user paused: a back-off that ends later must not start playback again.
        NetBlock.cancelResume()
        withController(call) { c ->
            c.pause()
            call.resolve()
        }
    }

    @PluginMethod
    fun seekTo(call: PluginCall) {
        val positionMs = longArg(call, "positionMs") ?: return call.reject("positionMs is required")
        withController(call) { c ->
            c.seekTo(positionMs.coerceAtLeast(0L))
            call.resolve()
        }
    }

    @PluginMethod
    fun skipToNext(call: PluginCall) {
        withController(call) { c ->
            if (c.hasNextMediaItem()) {
                c.seekToNextMediaItem()
                if (c.playbackState == Player.STATE_IDLE && !NetBlock.isBlocked()) c.prepare()
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun skipToPrevious(call: PluginCall) {
        withController(call) { c ->
            // Restarts the current track if past the first few seconds, like most players.
            c.seekToPrevious()
            if (c.playbackState == Player.STATE_IDLE && c.mediaItemCount > 0 && !NetBlock.isBlocked()) c.prepare()
            call.resolve()
        }
    }

    /** `skipToIndex({ index, expectId? })`; the service checks `expectId` (K2). */
    @PluginMethod
    fun skipToIndex(call: PluginCall) {
        val index = intArg(call, "index") ?: return call.reject("index is required")
        val expectId = stringArg(call, call.getString("expectId"), "expectId") ?: return
        withController(call) { c ->
            if (index !in 0 until c.mediaItemCount) {
                call.reject("index out of range: $index")
            } else {
                // In the service: queued tracks stay next; on an autoplay track the radio continues from it.
                val args = Bundle().apply {
                    putInt(QueueCommands.ARG_INDEX, index)
                    putExpect(expectId)
                }
                sendCommand(call, c, QueueCommands.SKIP_TO, args) {
                    if (it.playbackState == Player.STATE_IDLE && !NetBlock.isBlocked()) it.prepare()
                    call.resolve()
                }
            }
        }
    }

    @PluginMethod
    fun setShuffle(call: PluginCall) {
        val enabled = call.getBoolean("enabled") ?: return call.reject("enabled is required")
        withController(call) { c ->
            c.shuffleModeEnabled = enabled
            call.resolve()
        }
    }

    @PluginMethod
    fun setRepeat(call: PluginCall) {
        val mode = when (call.getString("mode")) {
            "off" -> Player.REPEAT_MODE_OFF
            "all" -> Player.REPEAT_MODE_ALL
            "one" -> Player.REPEAT_MODE_ONE
            else -> return call.reject("mode must be 'off', 'all' or 'one'")
        }
        withController(call) { c ->
            c.repeatMode = mode
            call.resolve()
        }
    }

    @PluginMethod
    fun setQuality(call: PluginCall) {
        StreamResolver.quality = when (call.getString("quality")) {
            "high" -> StreamResolver.Quality.HIGH
            "low" -> StreamResolver.Quality.LOW
            else -> return call.reject("quality must be 'high' or 'low'")
        }
        // Takes effect from the next resolution (next track / next prepare).
        call.resolve()
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        withController(call) { c -> call.resolve(buildState(c, fullQueue = true)) }
    }

    @PluginMethod
    fun getLaunchOptions(call: PluginCall) {
        // CI smoke test: proves a web -> native plugin call got through (CSP, bridge injection).
        Log.i(TAG, "BRIDGE getLaunchOptions")
        val result = JSObject()
        LaunchOptions.autoplay?.takeIf { it == "latest" }?.let { result.put("autoplay", it) }
        call.resolve(result)
    }

    /** `{ until: number | 0, reason?: 'BOT_CHECK' | 'RATE_LIMIT' | 'STREAM_FORBIDDEN' }` */
    @PluginMethod
    fun getBlockState(call: PluginCall) {
        val (until, reason) = NetBlock.active()
        val out = JSObject()
        out.put("until", until)
        reason?.let { out.put("reason", it.name) }
        call.resolve(out)
    }

    /**
     * `setNetworkPrefs({ ipv4: 'auto' | 'always' | 'off' })` (or the pre-1.0 `{ preferIpv4 }`):
     * applies to the shared OkHttp client (NewPipe and streaming) right away and is persisted
     * natively, so it also applies at the next service start before the web side loads. A
     * change lifts a running back-off: the next request goes out the new way.
     */
    @PluginMethod
    fun setNetworkPrefs(call: PluginCall) {
        val mode = when (call.getString("ipv4")) {
            "auto" -> Ipv4Mode.AUTO
            "always" -> Ipv4Mode.ALWAYS
            "off" -> Ipv4Mode.OFF
            null -> when (call.getBoolean("preferIpv4")) {
                true -> Ipv4Mode.ALWAYS
                false -> Ipv4Mode.AUTO
                null -> return call.reject("ipv4 is required")
            }
            else -> return call.reject("ipv4 must be 'auto', 'always' or 'off'")
        }
        val changed = mode != NetPrefs.mode
        NetPrefsStore.setMode(context, mode)
        if (changed) NetBlock.reset(keepLevel = false)
        call.resolve()
    }

    /** `retryNow()`: the banner's "Try now". Lifts the back-off; playback it stopped resumes. */
    @PluginMethod
    fun retryNow(call: PluginCall) {
        NetBlock.reset(keepLevel = true)
        call.resolve()
    }

    /**
     * `getNetStatus()`: for the Settings diagnostics line. `{ family?: 'IPv4' | 'IPv6',
     * ipv4: 'auto' | 'always' | 'off', autoIpv4: boolean, lastLimit?: { at, reason, surface } }`
     */
    @PluginMethod
    fun getNetStatus(call: PluginCall) {
        val out = JSObject()
        Families.last?.let { out.put("family", if (it == Family.IPV6) "IPv6" else "IPv4") }
        out.put("ipv4", NetPrefs.mode.name.lowercase())
        out.put("autoIpv4", NetPrefs.mode == Ipv4Mode.AUTO && NetPrefs.autoActive)
        NetBlock.lastLimit?.let {
            val l = JSObject()
            l.put("at", it.at)
            l.put("reason", it.reason.name)
            l.put("surface", it.surface.name.lowercase())
            out.put("lastLimit", l)
        }
        call.resolve(out)
    }

    /**
     * `setGestureExclusion({ left, top, width, height } | null)`, in CSS px relative to the
     * WebView: keeps Android's back gesture off that strip (the A-Z fast scroller). The height
     * is clamped to Android's 200dp limit, centred on the given rect. `null` (or no rect)
     * clears it. API 29+; a no-op below.
     */
    @PluginMethod
    fun setGestureExclusion(call: PluginCall) {
        val data = call.data
        fun num(key: String): Double? =
            if (data.has(key) && !data.isNull(key)) (data.opt(key) as? Number)?.toDouble() else null
        val left = num("left")
        val top = num("top")
        val width = num("width")
        val height = num("height")
        val clear = left == null || top == null || width == null || height == null
        main.post {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                call.resolve()
                return@post
            }
            val view = bridge?.webView
            if (view == null) {
                call.resolve()
                return@post
            }
            if (clear || width <= 0.0 || height <= 0.0) {
                view.systemGestureExclusionRects = emptyList()
            } else {
                val density = view.resources.displayMetrics.density
                val maxH = MAX_EXCLUSION_DP * density
                val h = (height * density).coerceAtMost(maxH.toDouble())
                val centreY = (top + height / 2.0) * density
                val l = (left * density).roundToInt()
                val t = (centreY - h / 2.0).roundToInt()
                val r = ((left + width) * density).roundToInt()
                val b = (centreY + h / 2.0).roundToInt()
                view.systemGestureExclusionRects = listOf(Rect(l, t, r, b))
            }
            call.resolve()
        }
    }

    // ---- YouTube back-off (main thread) ---------------------------------------------------

    /** While a back-off runs: pause (no prepare, no extraction) and remind the web. */
    private fun refuseWhileBlocked(c: MediaController): Boolean {
        val (until, reason) = NetBlock.active()
        if (reason == null) return false
        // Already false in the usual case; the service only cancels a resume on a change.
        if (c.playWhenReady) c.playWhenReady = false
        // The user asked to play: it starts once the back-off is over.
        NetBlock.wantResume()
        announceBlocked(until, reason, force = true)
        return true
    }

    private fun announceBlocked(until: Long, reason: BlockReason, force: Boolean = false) {
        if (until <= System.currentTimeMillis()) return
        if (announcedBlock && !force && lastBlockUntil == until) return
        announcedBlock = true
        lastBlockUntil = until
        val data = JSObject()
        data.put("until", until)
        data.put("reason", reason.name)
        notifyListeners("blocked", data)
        main.removeCallbacks(unblockTimer)
        main.postDelayed(unblockTimer, (until - System.currentTimeMillis()).coerceAtLeast(0L) + 100L)
    }

    private var lastBlockUntil = 0L

    private fun announceUnblocked() {
        main.removeCallbacks(unblockTimer)
        if (!announcedBlock) return
        announcedBlock = false
        notifyListeners("unblocked", JSObject())
    }

    // ---- state ----------------------------------------------------------------------------

    private fun emitState(c: MediaController) {
        if (!hasListeners("state")) return
        notifyListeners("state", buildState(c, fullQueue = false))
    }

    /**
     * Main thread only. Shape matches NativeState in the TS contract ([StateEncoder]). Unless
     * [fullQueue], `queueIds` is replaced by `queueIdsUnchanged: true` when the list did not
     * change since it was last sent (P1: no 1s re-send of a long list).
     */
    private fun buildState(c: MediaController, fullQueue: Boolean): JSObject {
        var queueIds: List<String>? = null
        if (fullQueue || queueDirty || lastQueueIds == null) {
            val ids = StateEncoder.queueIdsOf(c)
            queueDirty = false
            if (fullQueue || ids != lastQueueIds) queueIds = ids
            if (!fullQueue) lastQueueIds = ids
        }
        return StateEncoder.encode(c, queueIds)
    }

    /** Describes autoplay items the service added itself (Global radio) to the web, once each. */
    private fun announceTracks(c: MediaController) {
        if (!hasListeners("tracks")) return
        val arr = JSArray()
        for (i in 0 until c.mediaItemCount) {
            val item = c.getMediaItemAt(i)
            val id = item.mediaId
            if (!id.startsWith(QueueCommands.GLOBAL_PREFIX) || id in announcedTracks) continue
            if (item.mediaMetadata.extras?.getBoolean(QueueCommands.EXTRA_AUTOPLAY, false) != true) continue
            val ytId = JukeUris.ytIdOf(item) ?: continue
            announcedTracks.add(id)
            val o = JSObject()
            o.put("id", id)
            o.put("ytId", ytId)
            o.put("title", item.mediaMetadata.title?.toString() ?: "")
            o.put("artist", item.mediaMetadata.artist?.toString() ?: "")
            o.put("artworkUrl", item.mediaMetadata.artworkUri?.toString() ?: "")
            arr.put(o)
        }
        if (announcedTracks.size > MAX_ANNOUNCED) announcedTracks.clear()
        if (arr.length() == 0) return
        val data = JSObject()
        data.put("tracks", arr)
        notifyListeners("tracks", data)
    }

    // ---- helpers --------------------------------------------------------------------------

    /** The tracks, or null after rejecting the call (TOO_LARGE over the caps, K6). */
    private fun parseTracksOrReject(call: PluginCall, arr: JSONArray?): List<MediaItem>? = try {
        JukeTracks.parse(arr)
    } catch (e: TooLargeException) {
        call.reject(e.message, QueueCommands.TOO_LARGE)
        null
    } catch (e: Exception) {
        call.reject("Invalid tracks: ${e.message}")
        null
    }

    /**
     * An optional string argument checked against the cap: "" when absent, null after
     * rejecting the call with TOO_LARGE.
     */
    private fun stringArg(call: PluginCall, value: String?, what: String): String? = try {
        BridgeLimits.checkString(value, what) ?: ""
    } catch (e: TooLargeException) {
        call.reject(e.message, QueueCommands.TOO_LARGE)
        null
    }

    private fun Bundle.putExpect(expectId: String) {
        if (expectId.isNotEmpty()) putString(QueueCommands.ARG_EXPECT, expectId)
    }

    /** JS numbers arrive as Integer, Long or Double; PluginCall.getInt/getLong are type-strict. */
    private fun numArg(call: PluginCall, key: String): Number? {
        val data = call.data
        if (!data.has(key) || data.isNull(key)) return null
        return data.opt(key) as? Number
    }

    private fun intArg(call: PluginCall, key: String): Int? = numArg(call, key)?.toInt()

    private fun longArg(call: PluginCall, key: String): Long? = numArg(call, key)?.toLong()

    /** Ask once (API 33+) the first time playback starts; never blocks playback. */
    private fun maybeRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val ctx: Context = getContext() ?: return
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getBoolean(PREF_NOTIF_ASKED, false)) return
        val hostActivity = getActivity() ?: return
        prefs.edit().putBoolean(PREF_NOTIF_ASKED, true).apply()
        ActivityCompat.requestPermissions(
            hostActivity,
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            REQUEST_NOTIFICATIONS,
        )
    }

    companion object {
        private const val TAG = "CyberJukePlugin"
        private const val TICK_TAG = "CyberJukeTick"
        private const val TICK_MS = 1000L

        /** Android ignores gesture exclusion beyond 200dp per edge. */
        private const val MAX_EXCLUSION_DP = 200f
        private const val MAX_ANNOUNCED = 5000
        private const val PREFS = "cyberjuke_player"
        private const val PREF_NOTIF_ASKED = "notification_permission_asked"
        private const val REQUEST_NOTIFICATIONS = 0x4A55 // arbitrary, not a Capacitor plugin code
    }
}
