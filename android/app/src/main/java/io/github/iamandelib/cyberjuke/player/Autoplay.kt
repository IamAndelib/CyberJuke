package io.github.iamandelib.cyberjuke.player

import android.os.Bundle
import androidx.media3.session.SessionCommand
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Custom session commands for the queue model (P1, autoplay) between JukePlayerPlugin and
 * PlaybackService. Custom commands because the queue bookkeeping ([NativeQueue]) and the radio
 * state live in the service, next to its ExoPlayer.
 */
internal object QueueCommands {
    /** A new list: [ARG_TRACKS], [ARG_START], [ARG_POSITION], [ARG_LABEL], [ARG_MODE]. Queued items stay next. */
    const val ACTION_SET_LIST = "io.github.iamandelib.cyberjuke.SET_LIST"

    /** Autoplay tracks computed by the web side: [ARG_TRACKS] and the [ARG_SEED] they follow. */
    const val ACTION_ADD_AUTOPLAY = "io.github.iamandelib.cyberjuke.ADD_AUTOPLAY"

    /** The Autoplay setting: [ARG_ENABLED]. Off drops the autoplay items still to come. */
    const val ACTION_SET_AUTOPLAY = "io.github.iamandelib.cyberjuke.SET_AUTOPLAY"

    /** A tap in Up next: [ARG_INDEX]. On an autoplay item the radio continues from it. */
    const val ACTION_SKIP_TO = "io.github.iamandelib.cyberjuke.SKIP_TO"

    const val ARG_TRACKS = JukeCommands.ARG_TRACKS
    const val ARG_START = "startIndex"
    const val ARG_POSITION = "positionMs"
    const val ARG_LABEL = "label"
    const val ARG_MODE = "mode"
    const val ARG_SEED = "seedId"
    const val ARG_ENABLED = "enabled"
    const val ARG_INDEX = "index"

    val SET_LIST = SessionCommand(ACTION_SET_LIST, Bundle.EMPTY)
    val ADD_AUTOPLAY = SessionCommand(ACTION_ADD_AUTOPLAY, Bundle.EMPTY)
    val SET_AUTOPLAY = SessionCommand(ACTION_SET_AUTOPLAY, Bundle.EMPTY)
    val SKIP_TO = SessionCommand(ACTION_SKIP_TO, Bundle.EMPTY)
    val ALL = listOf(SET_LIST, ADD_AUTOPLAY, SET_AUTOPLAY, SKIP_TO)

    /** MediaMetadata extra (Boolean) marking an item added by autoplay. */
    const val EXTRA_AUTOPLAY = "cyberjukeAutoplay"

    /** Track ids of Global (YouTube Music) tracks: `ytm:<ytId>`, as on the web side. */
    const val GLOBAL_PREFIX = "ytm:"

    /** Autoplay items left when the queue is "low" and gets more (AP4). */
    const val LOW = 5
}

/**
 * Queue facts the state event carries beyond what a MediaController sees: written by
 * PlaybackService, read by JukePlayerPlugin, both on the main thread of the app process.
 */
internal object QueueInfo {
    /** "Add to queue" serials still waiting to play (see [NativeQueue.pendingSerials]). */
    @Volatile
    var pendingSerials: Set<Long> = emptySet()

    /** The play context of the current list (C2); null before the first list. */
    @Volatile
    var context: Pair<String, String>? = null

    /** The track autoplay follows (the started track, or the autoplay track tapped). */
    @Volatile
    var seedId: String? = null

    fun interface QueueLowListener {
        /** Autoplay has [left] items to go and the web side should add more after [seedId]. */
        fun onQueueLow(left: Int, seedId: String?)
    }

    private val lowListeners = CopyOnWriteArraySet<QueueLowListener>()

    fun addLow(l: QueueLowListener) = lowListeners.add(l)
    fun removeLow(l: QueueLowListener) = lowListeners.remove(l)
    fun emitQueueLow(left: Int, seedId: String?) = lowListeners.forEach { it.onQueueLow(left, seedId) }
}
