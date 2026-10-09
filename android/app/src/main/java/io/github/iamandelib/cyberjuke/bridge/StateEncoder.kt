package io.github.iamandelib.cyberjuke.bridge

import androidx.media3.common.C
import androidx.media3.common.Player
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import io.github.iamandelib.cyberjuke.playback.JukeCommands
import io.github.iamandelib.cyberjuke.playback.QueueCommands
import io.github.iamandelib.cyberjuke.playback.QueueInfo
import org.json.JSONObject

/**
 * The JukePlayer `state` event (NativeState in the TS contract) from a player: position,
 * the list, and Up next with each entry's kind (q = queued by you, l = the list,
 * a = autoplay) and index in the list (K1). Main thread only (the player's).
 */
internal object StateEncoder {
    /** Up next lists at most this many entries. */
    const val MAX_UP_NEXT = 50

    fun queueIdsOf(c: Player): List<String> {
        val count = c.mediaItemCount
        val ids = ArrayList<String>(count)
        for (i in 0 until count) ids.add(c.getMediaItemAt(i).mediaId)
        return ids
    }

    /** The state; [queueIds] null sends `queueIdsUnchanged: true` instead of the list. */
    fun encode(c: Player, queueIds: List<String>?): JSObject {
        val count = c.mediaItemCount
        val index = if (count == 0) -1 else c.currentMediaItemIndex
        val upNext = ArrayList<String>()
        val upNextIndex = JSArray()
        val kinds = StringBuilder()
        val pending = QueueInfo.pendingSerials
        val timeline = c.currentTimeline
        if (index >= 0 && !timeline.isEmpty && index < timeline.windowCount) {
            // Repeat-one is treated as off so the list shows what follows this track.
            val repeat = if (c.repeatMode == Player.REPEAT_MODE_ONE) Player.REPEAT_MODE_OFF else c.repeatMode
            val shuffle = c.shuffleModeEnabled
            var i = timeline.getNextWindowIndex(index, repeat, shuffle)
            while (i != C.INDEX_UNSET && i != index && upNext.size < MAX_UP_NEXT && i < count) {
                val item = c.getMediaItemAt(i)
                upNext.add(item.mediaId)
                upNextIndex.put(i)
                val extras = item.mediaMetadata.extras
                kinds.append(
                    when {
                        (extras?.getLong(JukeCommands.EXTRA_QUEUE_SERIAL, 0L) ?: 0L).let { it != 0L && it in pending } -> 'q'
                        extras?.getBoolean(QueueCommands.EXTRA_AUTOPLAY, false) == true -> 'a'
                        else -> 'l'
                    },
                )
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
        if (queueIds != null) {
            state.put("queueIds", JSArray(queueIds))
        } else {
            state.put("queueIdsUnchanged", true)
        }
        state.put("upNextIds", JSArray(upNext))
        state.put("upNextKinds", kinds.toString())
        state.put("upNextIndex", upNextIndex)
        val ctx = QueueInfo.context
        if (ctx != null && count > 0) {
            val o = JSObject()
            o.put("label", ctx.first)
            o.put("mode", ctx.second)
            state.put("context", o)
        } else {
            state.put("context", JSONObject.NULL)
        }
        state.put("seedId", (if (count > 0) QueueInfo.seedId else null) ?: JSONObject.NULL)
        return state
    }
}
