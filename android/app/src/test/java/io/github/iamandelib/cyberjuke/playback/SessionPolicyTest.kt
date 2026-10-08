package io.github.iamandelib.cyberjuke.playback

import androidx.media3.common.Player
import io.github.iamandelib.cyberjuke.playback.SessionPolicy.Access
import io.github.iamandelib.cyberjuke.playback.SessionPolicy.Controller
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionPolicyTest {
    private val own = "io.github.iamandelib.cyberjuke"

    private fun access(c: Controller) = SessionPolicy.access(c, own)

    @Test
    fun fullAccessForUsAndTheSystem() {
        assertEquals(Access.FULL, access(Controller(own, 10123, isTrusted = true)))
        assertEquals(Access.FULL, access(Controller(own, 10123, isTrusted = false, isMediaNotificationController = true)))
        assertEquals(Access.FULL, access(Controller("com.google.android.projection.gearhead", 10200, isTrusted = false, isAutoCompanionController = true)))
        assertEquals(Access.FULL, access(Controller("com.android.car.media", 10300, isTrusted = false, isAutomotiveController = true)))
        assertEquals(Access.FULL, access(Controller("com.android.bluetooth", 1002, isTrusted = true)))
        assertEquals(Access.FULL, access(Controller("android", 1000, isTrusted = true)))
        assertEquals(Access.FULL, access(Controller("com.android.systemui", 10050, isTrusted = true)))
    }

    @Test
    fun everyoneElseGetsTransportOnly() {
        // Our package name but not trusted (cannot happen for the real app): no.
        assertEquals(Access.TRANSPORT, access(Controller(own, 10999, isTrusted = false)))
        // A random app.
        assertEquals(Access.TRANSPORT, access(Controller("com.example.spy", 10400, isTrusted = false)))
        // Trusted only as a notification listener (a watch app): still transport only.
        assertEquals(Access.TRANSPORT, access(Controller("com.example.watch", 10401, isTrusted = true)))
        // A system-ish name without trust or a system uid.
        assertEquals(Access.TRANSPORT, access(Controller("com.android.systemui", 10050, isTrusted = false)))
        assertEquals(Access.TRANSPORT, access(Controller("android", 1000, isTrusted = false)))
    }

    @Test
    fun transportCommandsExcludeQueueAndMetadataEdits() {
        val t = Access.TRANSPORT
        for (c in listOf(
            Player.COMMAND_PLAY_PAUSE, Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_PREVIOUS,
            Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, Player.COMMAND_STOP, Player.COMMAND_PREPARE,
        )) assertTrue("$c", SessionPolicy.allows(t, c))
        for (c in listOf(
            Player.COMMAND_GET_TIMELINE, Player.COMMAND_CHANGE_MEDIA_ITEMS, Player.COMMAND_SET_MEDIA_ITEM,
            Player.COMMAND_SET_PLAYLIST_METADATA, Player.COMMAND_SET_SHUFFLE_MODE, Player.COMMAND_SET_REPEAT_MODE,
            Player.COMMAND_SET_SPEED_AND_PITCH, Player.COMMAND_SET_VOLUME, Player.COMMAND_SEEK_TO_MEDIA_ITEM,
            Player.COMMAND_SET_DEVICE_VOLUME_WITH_FLAGS, Player.COMMAND_SET_TRACK_SELECTION_PARAMETERS,
        )) assertFalse("$c", SessionPolicy.allows(t, c))
        assertTrue(SessionPolicy.allows(Access.FULL, Player.COMMAND_CHANGE_MEDIA_ITEMS))
    }

    @Test
    fun incomingItemsOnlyKeepValidYouTubeIds() {
        assertEquals("fJ9rUzIMcZQ", SessionPolicy.ytIdForIncoming("fJ9rUzIMcZQ", null))
        assertEquals("fJ9rUzIMcZQ", SessionPolicy.ytIdForIncoming(null, "fJ9rUzIMcZQ"))
        assertEquals("fJ9rUzIMcZQ", SessionPolicy.ytIdForIncoming("../../etc", "fJ9rUzIMcZQ"))
        assertNull(SessionPolicy.ytIdForIncoming(null, null))
        assertNull(SessionPolicy.ytIdForIncoming("fJ9rUzIMcZ", null)) // 10 chars
        assertNull(SessionPolicy.ytIdForIncoming("fJ9rUzIMcZQx", null)) // 12 chars
        assertNull(SessionPolicy.ytIdForIncoming("fJ9rUz/McZQ", "file:///data"))
        assertNull(SessionPolicy.ytIdForIncoming("ci-tone", null))
        assertEquals("ci-tone", SessionPolicy.ytIdForIncoming("ci-tone", null, extraAllowed = "ci-tone"))
    }

    @Test
    fun artworkOnlyFromYtimg() {
        assertTrue(SessionPolicy.isAllowedArtwork("https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg"))
        assertFalse(SessionPolicy.isAllowedArtwork("http://i.ytimg.com/vi/x/hqdefault.jpg"))
        assertFalse(SessionPolicy.isAllowedArtwork("https://i.ytimg.com.evil.example/x.jpg"))
        assertFalse(SessionPolicy.isAllowedArtwork("https://evil.example/i.ytimg.com/x.jpg"))
        assertFalse(SessionPolicy.isAllowedArtwork("https://user@i.ytimg.com/x.jpg"))
        assertFalse(SessionPolicy.isAllowedArtwork("https://i.ytimg.com:8443/x.jpg"))
        assertFalse(SessionPolicy.isAllowedArtwork("content://media/external/images/1"))
        assertFalse(SessionPolicy.isAllowedArtwork("file:///data/data/io.github.iamandelib.cyberjuke/shared_prefs/x.xml"))
        assertFalse(SessionPolicy.isAllowedArtwork(""))
        assertFalse(SessionPolicy.isAllowedArtwork(null))
    }
}
