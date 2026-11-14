package io.github.iamandelib.cyberjuke.playback

/** Pure, so JVM tests load it. */
internal object Radios {
    /**
     * A radio's first batch: the tapped song alone in a radio context ([count] items, [queued] of them
     * queued by you, which stay next), nothing on the way. It joins the list (it is the loop), so
     * repeat all lets it in (web player/types.ts firstBatchOfRadio, the same rule).
     */
    fun firstBatch(contextMode: String?, count: Int, queued: Int): Boolean = contextMode == "radio" && count - queued == 1

    /**
     * Whether to ask for the next list now (rule 2): nothing is on the way ([nextStart] -1, as the current
     * list starts) while the list keeps going ([keepsGoing]: autoplay on, or a station) and may grow
     * ([mayAdd]: not under repeat all, but a radio's first batch), with [count] items in the player and
     * loading (not [idle]: a restored session before its first Play asks for nothing). However many are
     * left: the next list is there long before it plays, also with the page asleep (web player
     * webPlayer.checkLow, the same rule).
     */
    fun needsNext(keepsGoing: Boolean, mayAdd: Boolean, nextStart: Int, count: Int, idle: Boolean): Boolean =
        keepsGoing && mayAdd && nextStart < 0 && count > 0 && !idle
}
