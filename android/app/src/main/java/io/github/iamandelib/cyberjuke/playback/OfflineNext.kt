package io.github.iamandelib.cyberjuke.playback

import androidx.media3.common.Player

/**
 * Offline, a move forward goes to the next song saved on the phone (the web's offline guard
 * allows Next on the same rule). Like the players that keep downloads apart, but where they stop
 * at a song that isn't saved, this goes on to one that is.
 */
internal object OfflineNext {
    /**
     * The first item after [from], in the order [next] gives (the timeline's: shuffle and repeat
     * all included, -1 = C.INDEX_UNSET at the end), that is [playable]; null when none is within
     * [count] steps or before the order comes back to [from].
     */
    fun target(from: Int, count: Int, next: (Int) -> Int, playable: (Int) -> Boolean): Int? {
        var i = from
        repeat(count) {
            i = next(i)
            if (i < 0 || i == from) return null
            if (playable(i)) return i
        }
        return null
    }
}

/**
 * Offline, the item a move forward from [from] goes to: the next liked song saved whole
 * ([AudioCache.savedLiked]), in play order, where Repeat one is as off (as Next). Null online,
 * or when no saved song is ahead: then the move is the player's own.
 */
internal fun Player.offlineNext(from: Int = currentMediaItemIndex): Int? {
    val t = currentTimeline
    if (AudioCache.online || from < 0 || from >= t.windowCount) return null
    val saved = AudioCache.savedLiked
    if (saved.isEmpty()) return null
    val mode = if (repeatMode == Player.REPEAT_MODE_ONE) Player.REPEAT_MODE_OFF else repeatMode
    return OfflineNext.target(
        from,
        mediaItemCount,
        { t.getNextWindowIndex(it, mode, shuffleModeEnabled) },
        { JukeUris.audioIdOf(getMediaItemAt(it)) in saved },
    )
}
