package io.github.iamandelib.cyberjuke.playback

import android.media.AudioDeviceInfo

/**
 * Whether audio has somewhere to go other than the phone itself (headphones, earbuds, a
 * Bluetooth or USB device): music paused while one was connected must not come back on the
 * speaker once it's gone. Pure (AudioOutputsTest).
 */
internal object AudioOutputs {
    /** The phone's own outputs, and ones that aren't really outputs for music. */
    private val BUILT_IN = setOf(
        AudioDeviceInfo.TYPE_UNKNOWN,
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE,
        AudioDeviceInfo.TYPE_TELEPHONY,
        AudioDeviceInfo.TYPE_REMOTE_SUBMIX,
        AudioDeviceInfo.TYPE_FM,
    )

    fun hasExternal(types: IntArray): Boolean = types.any { it !in BUILT_IN }
}
