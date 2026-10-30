package io.github.iamandelib.cyberjuke.bridge

import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.util.Util
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import io.github.iamandelib.cyberjuke.net.NetBlock
import io.github.iamandelib.cyberjuke.playback.AudioCache
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
        val previous = ArrayList<Int>()
        val pending = QueueInfo.pendingSerials
        val timeline = c.currentTimeline
        if (index >= 0 && !timeline.isEmpty && index < timeline.windowCount) {
            // To the end of the play order, whatever the repeat mode, as the web Queue's upNext:
            // repeat all's wrap would show the start again, out of its sections' order.
            val repeat = Player.REPEAT_MODE_OFF
            val shuffle = c.shuffleModeEnabled
            var i = timeline.getNextWindowIndex(index, repeat, shuffle)
            while (i != C.INDEX_UNSET && i != index && upNext.size < MAX_UP_NEXT && i < count) {
                val item = c.getMediaItemAt(i)
                upNext.add(item.mediaId)
                upNextIndex.put(i)
                val extras = item.mediaMetadata.extras
                kinds.append(
                    when {
                        (extras?.getLong(QueueCommands.EXTRA_QUEUE_SERIAL, 0L) ?: 0L).let { it != 0L && it in pending } -> 'q'
                        extras?.getBoolean(QueueCommands.EXTRA_AUTOPLAY, false) == true -> 'a'
                        else -> 'l'
                    },
                )
                i = timeline.getNextWindowIndex(i, repeat, shuffle)
            }
            // The tracks before it in play order, nearest first, then sent oldest first: Up next
            // shows them above the current one.
            var j = timeline.getPreviousWindowIndex(index, repeat, shuffle)
            while (j != C.INDEX_UNSET && j != index && previous.size < MAX_UP_NEXT && j < count) {
                previous.add(j)
                j = timeline.getPreviousWindowIndex(j, repeat, shuffle)
            }
        }

        // Not loaded yet (a restored session): the length it had when it was saved.
        val duration = c.duration.takeIf { it != C.TIME_UNSET && it > 0L }
            ?: c.currentMediaItem?.mediaMetadata?.durationMs ?: 0L
        val state = JSObject()
        // Playing or about to, by Media3's own play/pause button rule: also while it loads
        // (isBuffering), not on a call or at the end. The page's button shows Pause then.
        state.put("isPlaying", !Util.shouldShowPlayButton(c))
        state.put("isBuffering", c.playbackState == Player.STATE_BUFFERING)
        state.put("index", index)
        state.put("trackId", if (index >= 0) c.currentMediaItem?.mediaId ?: JSONObject.NULL else JSONObject.NULL)
        state.put("positionMs", if (index >= 0) c.currentPosition.coerceAtLeast(0L) else 0L)
        state.put("durationMs", duration.coerceAtLeast(0L))
        // None for a restored session not loaded yet: offline, an unsaved one then can't resume.
        state.put("bufferedAheadMs", if (index >= 0) StateEvents.bufferedAheadMs(c.bufferedPosition, c.currentPosition) else 0L)
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
        state.put("prevIndex", JSArray().apply { previous.asReversed().forEach { put(it) } })
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
        state.put("currentAuto", index >= 0 && c.currentMediaItem?.mediaMetadata?.extras?.getBoolean(QueueCommands.EXTRA_AUTOPLAY, false) == true)
        // The music waits for the carrier: an outage paused it (it resumes by itself once the
        // network is back), or it stalled with the network gone (WaitingRule).
        state.put(
            "waitingForNetwork",
            WaitingRule.waiting(
                count = count,
                isPlaying = c.isPlaying,
                playWhenReady = c.playWhenReady,
                buffering = c.playbackState == Player.STATE_BUFFERING,
                outagePause = NetBlock.waitingForNetwork(),
                validated = AudioCache.online,
            ),
        )
        return state
    }
}
