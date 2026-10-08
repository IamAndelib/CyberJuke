package io.github.iamandelib.cyberjuke.player

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionToken
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject

/**
 * Capacitor bridge to PlaybackService. Contract (TS side):
 *   setQueue, addItems, queueNext, removeItem, moveItem, play, pause, seekTo, skipToNext,
 *   skipToPrevious, skipToIndex, setShuffle, setRepeat, setQuality, getState,
 *   getLaunchOptions; events 'state' and 'trackError'.
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

    private val ticker = object : Runnable {
        override fun run() {
            val c = controller ?: return
            emitState(c)
            if (c.isPlaying) main.postDelayed(this, TICK_MS)
        }
    }

    private val playerListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            val c = controller ?: return
            emitState(c)
            if (events.contains(Player.EVENT_IS_PLAYING_CHANGED)) {
                main.removeCallbacks(ticker)
                if (c.isPlaying) main.postDelayed(ticker, TICK_MS)
            }
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
        PlayerBus.add(trackErrorListener)
        main.post { connect() }
    }

    override fun handleOnDestroy() {
        PlayerBus.remove(trackErrorListener)
        main.post {
            main.removeCallbacks(ticker)
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
        if (controllerFuture != null) return
        val ctx: Context = context
        val token = SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))
        val future = MediaController.Builder(ctx, token)
            .setListener(object : MediaController.Listener {
                override fun onDisconnected(controller: MediaController) {
                    Log.w(TAG, "MediaController disconnected")
                    onControllerLost()
                }
            })
            .buildAsync()
        controllerFuture = future
        future.addListener({
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
            emitState(c)
            if (c.isPlaying) {
                main.removeCallbacks(ticker)
                main.postDelayed(ticker, TICK_MS)
            }
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
            Log.e(TAG, "${call.methodName} failed", e)
            call.reject(e.message ?: e.toString(), e)
        }
    }

    // ---- plugin methods -----------------------------------------------------------------------

    @PluginMethod
    fun setQueue(call: PluginCall) {
        val items = try {
            parseTracks(call.getArray("tracks"))
        } catch (e: Exception) {
            call.reject("Invalid tracks: ${e.message}")
            return
        }
        val startIndex = intArg(call, "startIndex") ?: 0
        val positionMs = longArg(call, "positionMs") ?: 0L
        val playWhenReady = call.getBoolean("playWhenReady", true) ?: true
        withController(call) { c ->
            if (items.isEmpty()) {
                c.clearMediaItems()
            } else {
                val start = startIndex.coerceIn(0, items.size - 1)
                c.setMediaItems(items, start, positionMs.coerceAtLeast(0L))
                c.playWhenReady = playWhenReady
                c.prepare()
                if (playWhenReady) maybeRequestNotificationPermission()
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun addItems(call: PluginCall) {
        val items = try {
            parseTracks(call.getArray("tracks"))
        } catch (e: Exception) {
            call.reject("Invalid tracks: ${e.message}")
            return
        }
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
        val count = try {
            parseTracks(tracks).size // validate here so bad input rejects with a clear message
        } catch (e: Exception) {
            call.reject("Invalid tracks: ${e.message}")
            return
        }
        if (count == 0) {
            call.resolve()
            return
        }
        val args = Bundle().apply { putString(JukeCommands.ARG_TRACKS, tracks.toString()) }
        withController(call) { c ->
            val future = c.sendCustomCommand(JukeCommands.QUEUE_NEXT, args)
            future.addListener({
                val result = try {
                    future.get()
                } catch (e: Exception) {
                    call.reject("queueNext failed: ${e.message}")
                    return@addListener
                }
                if (result.resultCode == SessionResult.RESULT_SUCCESS) {
                    call.resolve()
                } else {
                    call.reject("queueNext failed: result ${result.resultCode}")
                }
            }, ContextCompat.getMainExecutor(context))
        }
    }

    @PluginMethod
    fun removeItem(call: PluginCall) {
        val index = intArg(call, "index") ?: return call.reject("index is required")
        withController(call) { c ->
            if (index !in 0 until c.mediaItemCount) {
                call.reject("index out of range: $index")
            } else {
                c.removeMediaItem(index)
                call.resolve()
            }
        }
    }

    @PluginMethod
    fun moveItem(call: PluginCall) {
        val from = intArg(call, "from") ?: return call.reject("from is required")
        val to = intArg(call, "to") ?: return call.reject("to is required")
        withController(call) { c ->
            val n = c.mediaItemCount
            if (from !in 0 until n || to !in 0 until n) {
                call.reject("index out of range: from=$from to=$to count=$n")
            } else {
                if (from != to) c.moveMediaItem(from, to)
                call.resolve()
            }
        }
    }

    @PluginMethod
    fun play(call: PluginCall) {
        withController(call) { c ->
            if (c.mediaItemCount > 0) {
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
                if (c.playbackState == Player.STATE_IDLE) c.prepare()
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun skipToPrevious(call: PluginCall) {
        withController(call) { c ->
            // Restarts the current track if past the first few seconds, like most players.
            c.seekToPrevious()
            if (c.playbackState == Player.STATE_IDLE && c.mediaItemCount > 0) c.prepare()
            call.resolve()
        }
    }

    @PluginMethod
    fun skipToIndex(call: PluginCall) {
        val index = intArg(call, "index") ?: return call.reject("index is required")
        withController(call) { c ->
            if (index !in 0 until c.mediaItemCount) {
                call.reject("index out of range: $index")
            } else {
                c.seekTo(index, 0L)
                if (c.playbackState == Player.STATE_IDLE) c.prepare()
                call.resolve()
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
        withController(call) { c -> call.resolve(buildState(c)) }
    }

    @PluginMethod
    fun getLaunchOptions(call: PluginCall) {
        val result = JSObject()
        LaunchOptions.autoplay?.takeIf { it == "latest" }?.let { result.put("autoplay", it) }
        call.resolve(result)
    }

    // ---- state ----------------------------------------------------------------------------

    private fun emitState(c: MediaController) {
        if (!hasListeners("state")) return
        notifyListeners("state", buildState(c))
    }

    /** Main thread only. Shape matches NativeState in the TS contract. */
    private fun buildState(c: MediaController): JSObject {
        val count = c.mediaItemCount
        val index = if (count == 0) -1 else c.currentMediaItemIndex
        val queueIds = ArrayList<String>(count)
        for (i in 0 until count) queueIds.add(c.getMediaItemAt(i).mediaId)

        val upNext = ArrayList<String>()
        val timeline = c.currentTimeline
        if (index >= 0 && !timeline.isEmpty && index < timeline.windowCount) {
            // Repeat-one is treated as off so the list shows what follows this track.
            val repeat = if (c.repeatMode == Player.REPEAT_MODE_ONE) Player.REPEAT_MODE_OFF else c.repeatMode
            val shuffle = c.shuffleModeEnabled
            var i = timeline.getNextWindowIndex(index, repeat, shuffle)
            while (i != C.INDEX_UNSET && i != index && upNext.size < MAX_UP_NEXT && i < count) {
                upNext.add(c.getMediaItemAt(i).mediaId)
                i = timeline.getNextWindowIndex(i, repeat, shuffle)
            }
        }

        val duration = c.duration
        val state = JSObject()
        state.put("isPlaying", c.isPlaying)
        state.put("isBuffering", c.playbackState == Player.STATE_BUFFERING)
        state.put("index", index)
        state.put("trackId", if (index >= 0) c.currentMediaItem?.mediaId ?: JSONObject.NULL else JSONObject.NULL)
        state.put("positionMs", if (index >= 0) c.currentPosition.coerceAtLeast(0L) else 0L)
        state.put("durationMs", if (duration == C.TIME_UNSET || duration < 0) 0L else duration)
        state.put("shuffle", c.shuffleModeEnabled)
        state.put(
            "repeat",
            when (c.repeatMode) {
                Player.REPEAT_MODE_ONE -> "one"
                Player.REPEAT_MODE_ALL -> "all"
                else -> "off"
            },
        )
        state.put("queueIds", JSArray(queueIds))
        state.put("upNextIds", JSArray(upNext))
        return state
    }

    // ---- helpers --------------------------------------------------------------------------

    private fun parseTracks(arr: JSONArray?): List<MediaItem> = JukeTracks.parse(arr)

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
        private const val TICK_MS = 1000L
        private const val MAX_UP_NEXT = 50
        private const val PREFS = "cyberjuke_player"
        private const val PREF_NOTIF_ASKED = "notification_permission_asked"
        private const val REQUEST_NOTIFICATIONS = 0x4A55 // arbitrary, not a Capacitor plugin code
    }
}
