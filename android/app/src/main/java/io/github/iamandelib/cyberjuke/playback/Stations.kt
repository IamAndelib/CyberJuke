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

    /** What Home's Shuffle labels its list: this, or this + " · genre" (web player/autoplay.ts shuffleLabel). */
    const val SHUFFLE = "Jukebox shuffle"

    /**
     * More follows the list for [seedId] (queueLow, addAutoplay, autoplay rows, kept when Autoplay
     * goes off): Autoplay on, a Jukebox shuffle (its [SHUFFLE] label, any seed), or stations
     * playing (its list's [contextLabel], a station track as the seed: of the station tuned in, or
     * of another once the chain has moved on), which lead on to the next station whatever the
     * setting: it isn't autoplay, it is the radio. A station's track in another list (Liked,
     * Recently played) is just a track. The same rule as the web's (player/radio.ts stationPlaying);
     * the web picks the next station (stations are web data) and adds it (addAutoplay).
     */
    fun keepsGoing(autoplayEnabled: Boolean, seedId: String?, contextLabel: String?): Boolean =
        autoplayEnabled ||
            (seedId?.startsWith(PREFIX) == true && contextLabel?.startsWith(LABEL) == true) ||
            contextLabel == SHUFFLE || contextLabel?.startsWith("$SHUFFLE · ") == true

    /**
     * Autoplay may add unless repeat all is on: it loops the list you're in, so nothing comes after
     * it (web player/types.ts mayAutoplay, the same rule), but for a radio's first batch ([Radios.firstBatch]).
     */
    fun mayAutoplay(repeatMode: Int): Boolean = repeatMode != Player.REPEAT_MODE_ALL
}
