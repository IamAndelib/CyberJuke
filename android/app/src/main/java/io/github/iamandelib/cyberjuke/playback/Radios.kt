package io.github.iamandelib.cyberjuke.playback

/** Pure, so JVM tests load it. */
internal object Radios {
    /**
     * A radio's first batch: the tapped song alone in a radio context, nothing on the way. It joins
     * the list (it is the loop), so repeat all lets it in (web player/types.ts firstBatchOfRadio, the same rule).
     */
    fun firstBatch(contextMode: String?, count: Int): Boolean = contextMode == "radio" && count == 1
}
