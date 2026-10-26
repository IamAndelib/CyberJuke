package io.github.iamandelib.cyberjuke.playback

/**
 * Signal Radio (Cyberspace 4.0): a station's tracks have ids `sig:<station>:<ytId>`, as on the
 * web side (player/radio.ts). Pure, no Android or Media3 classes (QueueInfoTest).
 */
internal object Stations {
    const val PREFIX = "sig:"

    /**
     * More follows the list for [seedId] (queueLow, addAutoplay, autoplay rows): Autoplay on, or
     * a station, which plays on round after round whatever the setting (it isn't autoplay: it is
     * the station).
     */
    fun keepsGoing(autoplayEnabled: Boolean, seedId: String?): Boolean =
        autoplayEnabled || seedId?.startsWith(PREFIX) == true
}
