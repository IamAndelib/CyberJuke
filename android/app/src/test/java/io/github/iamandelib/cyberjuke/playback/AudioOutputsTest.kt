package io.github.iamandelib.cyberjuke.playback

import android.media.AudioDeviceInfo
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioOutputsTest {
    @Test
    fun headphonesAndBluetoothCountTheSpeakerDoesNot() {
        assertFalse(AudioOutputs.hasExternal(intArrayOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, AudioDeviceInfo.TYPE_TELEPHONY)))
        assertFalse(AudioOutputs.hasExternal(intArrayOf()))
        assertTrue(AudioOutputs.hasExternal(intArrayOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_WIRED_HEADPHONES)))
        assertTrue(AudioOutputs.hasExternal(intArrayOf(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP)))
        assertTrue(AudioOutputs.hasExternal(intArrayOf(AudioDeviceInfo.TYPE_USB_HEADSET)))
    }
}
