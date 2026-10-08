package io.github.iamandelib.cyberjuke.playback

import androidx.media3.common.Player
import java.net.URI

/**
 * Who may do what with our MediaSession (S1), as pure functions (SessionPolicyTest).
 *
 * PlaybackService is exported so system UI, Bluetooth, Android Auto and watch apps can control
 * playback. Any installed app can bind to it too, so only these get full access:
 * - our own package (the JukePlayer plugin's MediaController), when Media3 trusts it;
 * - the media notification controller, Android Auto (companion) and Automotive;
 * - trusted system controllers: Media3 trusts them (MEDIA_CONTENT_CONTROL, STATUS_BAR_SERVICE,
 *   the system uid) AND they run as a core system uid or are System UI.
 * Everyone else (including apps trusted only because they are notification listeners) gets
 * transport commands only: play/pause, seek, next/previous, stop, plus reading the current
 * item. No timeline (the whole queue), no playlist metadata, no media item edits, no
 * shuffle/repeat/speed/volume changes and no custom commands.
 */
internal object SessionPolicy {
    enum class Access { FULL, TRANSPORT }

    /** The parts of Media3's ControllerInfo the decision needs. */
    data class Controller(
        val packageName: String,
        val uid: Int,
        val isTrusted: Boolean,
        val isMediaNotificationController: Boolean = false,
        val isAutoCompanionController: Boolean = false,
        val isAutomotiveController: Boolean = false,
    )

    /** Android's first app uid (Process.FIRST_APPLICATION_UID); below it are core system uids. */
    private const val FIRST_APPLICATION_UID = 10_000

    /** System UI runs with an app uid but holds STATUS_BAR_SERVICE. */
    private val SYSTEM_UI_PACKAGES = setOf("com.android.systemui")

    fun access(c: Controller, ownPackage: String): Access {
        if (c.isMediaNotificationController || c.isAutoCompanionController || c.isAutomotiveController) {
            return Access.FULL
        }
        if (!c.isTrusted) return Access.TRANSPORT
        if (c.packageName == ownPackage) return Access.FULL
        if (c.uid in 0 until FIRST_APPLICATION_UID) return Access.FULL
        if (c.packageName in SYSTEM_UI_PACKAGES) return Access.FULL
        return Access.TRANSPORT
    }

    /** Player commands a TRANSPORT controller gets (intersected with what the player offers). */
    val TRANSPORT_COMMANDS: Set<Int> = setOf(
        Player.COMMAND_PLAY_PAUSE,
        Player.COMMAND_PREPARE,
        Player.COMMAND_STOP,
        Player.COMMAND_SEEK_TO_DEFAULT_POSITION,
        Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_PREVIOUS,
        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_NEXT,
        Player.COMMAND_SEEK_BACK,
        Player.COMMAND_SEEK_FORWARD,
        Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
        Player.COMMAND_GET_METADATA,
        Player.COMMAND_GET_AUDIO_ATTRIBUTES,
        Player.COMMAND_RELEASE,
    )

    fun allows(access: Access, command: Int): Boolean =
        access == Access.FULL || command in TRANSPORT_COMMANDS

    // ---- media items coming in from a controller (onAddMediaItems / onSetMediaItems) ----------

    private val YT_ID = Regex("^[A-Za-z0-9_-]{11}$")

    fun isValidYtId(id: String?): Boolean = id != null && YT_ID.matches(id)

    /**
     * The ytId to rebuild an incoming item's URI from: the one in our own `cyberjuke://yt/<id>`
     * URI, else the metadata extra; null (drop the item) unless it is a valid 11-char id.
     * [extraAllowed] lets debuggable builds pass the CI test tone id through.
     */
    fun ytIdForIncoming(uriYtId: String?, extrasYtId: String?, extraAllowed: String? = null): String? {
        for (id in listOf(uriYtId, extrasYtId)) {
            if (isValidYtId(id)) return id
            if (id != null && id == extraAllowed) return id
        }
        return null
    }

    /** Artwork is only loaded from `https://i.ytimg.com/...`; anything else is dropped. */
    fun isAllowedArtwork(url: String?): Boolean {
        if (url.isNullOrEmpty()) return false
        val uri = try {
            URI(url)
        } catch (_: Exception) {
            return false
        }
        return uri.scheme == "https" && uri.host == "i.ytimg.com" && uri.userInfo == null &&
            (uri.port == -1 || uri.port == 443)
    }
}
