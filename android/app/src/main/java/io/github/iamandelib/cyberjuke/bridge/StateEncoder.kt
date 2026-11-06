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
        val lap = ArrayList<Int>()
        // The Up next entries Previous walked back over (heard in this lap: Repeat all's next lap is all to come): an Undo keeps it.
        val heardAhead = ArrayList<Int>()
        val pending = QueueInfo.pendingSerials
        val heard = QueueInfo.heardUids
        val lapHeard = QueueInfo.lapUids
        fun serialAt(i: Int) = c.getMediaItemAt(i).mediaMetadata.extras?.getLong(QueueCommands.EXTRA_QUEUE_SERIAL, 0L) ?: 0L
        fun uidAt(i: Int) = c.getMediaItemAt(i).mediaMetadata.extras?.getLong(QueueCommands.EXTRA_UID, 0L) ?: 0L
        fun heardAt(i: Int, uids: Set<Long> = heard) = uidAt(i).let { it != 0L && it in uids }
        fun autoAt(i: Int) = c.getMediaItemAt(i).mediaMetadata.extras?.getBoolean(QueueCommands.EXTRA_AUTOPLAY, false) == true
        // The songs you queued keep their serial after they play: the "queued by you" mark (rule 8).
        val mine = (0 until count).filter { serialAt(it) != 0L }
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
                if (heardAt(i, lapHeard)) heardAhead.add(i)
                i = timeline.getNextWindowIndex(i, repeat, shuffle)
            }
            // The heard tracks before it in play order ("Played"), nearest first, then sent oldest
            // first: the queue shows them above the current one.
            var j = timeline.getPreviousWindowIndex(index, repeat, shuffle)
            while (j != C.INDEX_UNSET && j != index && previous.size < MAX_UP_NEXT && j < count) {
                if (heardAt(j)) previous.add(j)
                j = timeline.getPreviousWindowIndex(j, repeat, shuffle)
            }
            // The next lap ("From the top"), repeat all only: the play order from its first item up to the
            // current one, without the songs you queued (rule 8), the first ones.
            if (c.repeatMode == Player.REPEAT_MODE_ALL) {
                var k = timeline.getFirstWindowIndex(shuffle)
                while (k != C.INDEX_UNSET && k != index && lap.size < MAX_UP_NEXT && k < count) {
                    if (serialAt(k) == 0L) lap.add(k)
                    k = timeline.getNextWindowIndex(k, repeat, shuffle)
                }
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
        state.put("mineIndex", JSArray(mine))
        state.put("lapIndex", JSArray(lap))
        state.put("heardIndex", JSArray(heardAhead))
        // The Played and "From the top" entries autoplay added: an Undo keeps the tag.
        state.put("autoIndex", JSArray((previous + lap).distinct().filter { autoAt(it) }))
        // Queue indices like the above; nothing before the list start is of this list, and -1 is no autoplay on the way.
        state.put("listStart", if (count > 0) QueueInfo.listStart else 0)
        state.put("nextStart", if (count > 0) QueueInfo.nextStart else -1)
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
