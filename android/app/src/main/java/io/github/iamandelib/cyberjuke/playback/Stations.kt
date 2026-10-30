package io.github.iamandelib.cyberjuke.playback

import androidx.media3.common.Player

/**
 * Signal Radio (Cyberspace 4.0): a station's tracks have ids `sig:<station>:<ytId>`, and the
 * Radio tab starts a station as a list labelled `Signal Radio · <CALLSIGN>` (web player/radio.ts,
 * STATION_LABEL), which nothing else does. Also what may follow a list ([keepsGoing], [mayAutoplay]).
 * Pure: no Android classes, Media3's repeat constants only (inlined), so JVM tests load it (QueueInfoTest).
 */
internal object Stations {
    const val PREFIX = "sig:"
    const val LABEL = "Signal Radio · "

    /**
     * More follows the list for [seedId] (queueLow, addAutoplay, autoplay rows, kept when Autoplay
     * goes off): Autoplay on, or a station playing (its list's [contextLabel], a station track as
     * the seed), which plays on round after round whatever the setting: it isn't autoplay, it is
     * the station. A station's track in another list (Liked, Recently played) is just a track.
     * The web (player/radio.ts stationPlaying) also checks that the label names the seed's own
     * station; native doesn't know callsigns, and only the Radio tab makes such a label.
     */
    fun keepsGoing(autoplayEnabled: Boolean, seedId: String?, contextLabel: String?): Boolean =
        autoplayEnabled || (seedId?.startsWith(PREFIX) == true && contextLabel?.startsWith(LABEL) == true)

    /**
     * Autoplay may add to a list of [count] items: but with repeat all, which loops what you
     * started; then only a single song gets its first batch, its radio, for repeat to loop (web
     * player/types.ts mayAutoplay, the same rule).
     */
    fun mayAutoplay(repeatMode: Int, count: Int): Boolean = repeatMode != Player.REPEAT_MODE_ALL || count == 1
}
