package io.github.iamandelib.cyberjuke.playback

import androidx.media3.common.Player
import io.github.iamandelib.cyberjuke.playback.SessionPolicy.Access
import io.github.iamandelib.cyberjuke.playback.SessionPolicy.Controller
import io.github.iamandelib.cyberjuke.playback.SessionPolicy.Grant
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
        assertEquals(Access.FULL, access(Controller(own, 10123, isTrusted = false, isMediaNotificationController = true, packageNameVerified = true)))
        assertEquals(Access.FULL, access(Controller("com.google.android.projection.gearhead", 10200, isTrusted = false, isAutoCompanionController = true, packageNameVerified = true)))
        assertEquals(Access.FULL, access(Controller("com.android.car.media", 10300, isTrusted = false, isAutomotiveController = true, packageNameVerified = true)))
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
    fun theSystemControllersCountOnlyWithAVerifiedPackageName() {
        // Media3 recognises these three by package name; unverified, they are like any other app.
        for (c in listOf(
            Controller("com.google.android.projection.gearhead", 10400, isTrusted = false, isAutoCompanionController = true),
            Controller("com.android.car.media", 10400, isTrusted = false, isAutomotiveController = true),
            Controller(own, 10400, isTrusted = false, isMediaNotificationController = true),
        )) {
            assertEquals(c.packageName, Access.TRANSPORT, access(c))
            assertEquals(c.packageName, Grant.TRANSPORT, grant(c))
            assertEquals(c.packageName, Access.FULL, access(c.copy(packageNameVerified = true)))
        }
    }

    @Test
    fun transportCommandsExcludeQueueAndMetadataEdits() {
        val t = SessionPolicy.TRANSPORT_COMMANDS
        for (c in listOf(
            Player.COMMAND_PLAY_PAUSE, Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_PREVIOUS,
            Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, Player.COMMAND_STOP, Player.COMMAND_PREPARE,
        )) assertTrue("$c", c in t)
        for (c in listOf(
            Player.COMMAND_GET_TIMELINE, Player.COMMAND_CHANGE_MEDIA_ITEMS, Player.COMMAND_SET_MEDIA_ITEM,
            Player.COMMAND_SET_PLAYLIST_METADATA, Player.COMMAND_SET_SHUFFLE_MODE, Player.COMMAND_SET_REPEAT_MODE,
            Player.COMMAND_SET_SPEED_AND_PITCH, Player.COMMAND_SET_VOLUME, Player.COMMAND_SEEK_TO_MEDIA_ITEM,
            Player.COMMAND_SET_DEVICE_VOLUME_WITH_FLAGS, Player.COMMAND_SET_TRACK_SELECTION_PARAMETERS,
        )) assertFalse("$c", c in t)
    }

    @Test
    fun systemUidsCountInEveryUser() {
        // Work profile / secondary user 10: Bluetooth is 1_001_002, still a core system uid.
        assertEquals(Access.FULL, access(Controller("com.android.bluetooth", 1_001_002, isTrusted = true)))
        assertEquals(Access.FULL, access(Controller("android", 1_001_000, isTrusted = true)))
        // An ordinary app in user 10 is not.
        assertEquals(Access.TRANSPORT, access(Controller("com.example.watch", 1_010_401, isTrusted = true)))
    }

    private val token = "a1b2c3d4e5f6"

    private fun grant(c: Controller) = SessionPolicy.grant(c, own, token)

    @Test
    fun onlyThePluginGetsTheQueueCommands() {
        val plugin = Controller(own, 10123, isTrusted = true, connectionToken = token)
        assertEquals(Grant.PLUGIN, grant(plugin))
        assertTrue(SessionPolicy.mayUseQueueCommands(plugin, own, token))

        // The media notification controller: our package and uid, but no token. Any app can
        // make it send a custom command (CUSTOM_NOTIFICATION_ACTION), so no queue commands.
        val notification = Controller(own, 10123, isTrusted = true, isMediaNotificationController = true)
        assertEquals(Grant.NOTIFICATION, grant(notification))
        assertFalse(SessionPolicy.mayUseQueueCommands(notification, own, token))
        // ...even if it somehow carried the token.
        assertEquals(Grant.NOTIFICATION, grant(notification.copy(connectionToken = token)))

        // Our package without the token, or with a wrong or empty one: player commands only.
        for (t in listOf(null, "", "a1b2c3d4e5f7", token + "0")) {
            val c = Controller(own, 10123, isTrusted = true, connectionToken = t)
            assertEquals("token $t", Grant.FULL, grant(c))
            assertFalse(SessionPolicy.mayUseQueueCommands(c, own, token))
        }
        // The token from another package (or untrusted) never counts.
        assertEquals(Grant.TRANSPORT, grant(Controller("com.example.spy", 10400, isTrusted = false, connectionToken = token)))
        assertEquals(Grant.TRANSPORT, grant(Controller(own, 10999, isTrusted = false, connectionToken = token)))
        // A trusted system controller with a guessed token is still not the plugin.
        assertEquals(Grant.FULL, grant(Controller("android", 1000, isTrusted = true, connectionToken = token)))
        assertEquals(Grant.FULL, grant(Controller("com.google.android.projection.gearhead", 10200, isTrusted = false, isAutoCompanionController = true, packageNameVerified = true)))
    }

    @Test
    fun theNotificationAndPlatformSessionHaveNoTimeline() {
        // Media3 gives the platform session the notification controller's commands: without
        // the timeline it publishes no queue (current item and transport only).
        assertTrue(Player.COMMAND_GET_TIMELINE in SessionPolicy.NOTIFICATION_HIDDEN_COMMANDS)
        for (c in listOf(
            Player.COMMAND_PLAY_PAUSE, Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_PREVIOUS,
            Player.COMMAND_GET_CURRENT_MEDIA_ITEM, Player.COMMAND_GET_METADATA,
        )) assertFalse("$c", c in SessionPolicy.NOTIFICATION_HIDDEN_COMMANDS)
    }

    @Test
    fun jukeboxMp3sAreLatexShareLinksOnly() {
        assertTrue(SessionPolicy.isValidMp3Url("https://latex.gg/share/IZq8cMcx.mp3"))
        assertEquals("IZq8cMcx.mp3", SessionPolicy.mp3FileOf("https://latex.gg/share/IZq8cMcx.mp3"))
        for (bad in listOf(
            "http://latex.gg/share/IZq8cMcx.mp3",
            "https://latex.gg/share/IZq8cMcx",
            "https://latex.gg/files/IZq8cMcx.mp3",
            "https://evil.latex.gg/share/IZq8cMcx.mp3",
            "https://latex.gg.evil.example/share/IZq8cMcx.mp3",
            "https://latex.gg/share/../x.mp3",
            "https://latex.gg/share/IZq8cMcx.mp3?x=1",
            "file:///sdcard/x.mp3",
            "",
        )) {
            assertFalse(bad, SessionPolicy.isValidMp3Url(bad))
            assertNull(bad, SessionPolicy.mp3FileOf(bad))
        }
        assertFalse(SessionPolicy.isValidMp3Url(null))
        assertTrue(SessionPolicy.isValidMp3File("IZq8cMcx.mp3"))
        // The item's file name rebuilds exactly the link it came from, and nothing else.
        val link = "https://latex.gg/share/IZq8cMcx.mp3"
        assertEquals(link, SessionPolicy.mp3UrlForFile(SessionPolicy.mp3FileOf(link)))
        assertNull(SessionPolicy.mp3UrlForFile("../x.mp3"))
        assertNull(SessionPolicy.mp3UrlForFile("x.mp3?y"))
        assertNull(SessionPolicy.mp3UrlForFile(null))
        assertFalse(SessionPolicy.isValidMp3File("../IZq8cMcx.mp3"))
        assertFalse(SessionPolicy.isValidMp3File("x.mp3/y"))
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
    fun artworkOnlyFromYtimgAndCyberspaceUploads() {
        assertTrue(SessionPolicy.isAllowedArtwork("https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg"))
        // A Jukebox MP3's cover, from Cyberspace's uploads only.
        assertTrue(SessionPolicy.isAllowedArtwork("https://bunker.cyberspace.online/uploads/jukebox/Q7qx/1792922249462-97625ca1611e2070.jpg"))
        assertFalse(SessionPolicy.isAllowedArtwork("https://bunker.cyberspace.online/admin/x.jpg"))
        assertFalse(SessionPolicy.isAllowedArtwork("https://bunker.cyberspace.online/uploads/x.jpg?redirect=evil"))
        assertFalse(SessionPolicy.isAllowedArtwork("http://bunker.cyberspace.online/uploads/x.jpg"))
        assertFalse(SessionPolicy.isAllowedArtwork("https://bunker.cyberspace.online.evil.example/uploads/x.jpg"))
        // No way out of /uploads/: no dot segments, no escapes.
        assertFalse(SessionPolicy.isAllowedArtwork("https://bunker.cyberspace.online/uploads/../admin/x.jpg"))
        assertFalse(SessionPolicy.isAllowedArtwork("https://bunker.cyberspace.online/uploads/./x.jpg"))
        assertFalse(SessionPolicy.isAllowedArtwork("https://bunker.cyberspace.online/uploads/%2e%2e/x.jpg"))
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
