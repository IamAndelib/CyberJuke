package io.github.iamandelib.cyberjuke.playback

import androidx.media3.common.Player
import java.net.URI
import java.security.MessageDigest

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
 *
 * Within FULL, [grant] narrows two controllers further:
 * - The private queue commands (QueueCommands, QUEUE_NEXT) go only to the JukePlayer plugin's
 *   controller, which proves itself with a random per-process token in its connection hints
 *   ([ControllerKey]). The media notification controller has our package and uid too, and any
 *   app can make it send a custom command (Media3's CUSTOM_NOTIFICATION_ACTION intent).
 * - The media notification controller gets no timeline: Media3 configures the platform
 *   session (lock screen, system media controls, every notification listener) with its
 *   commands, so with the timeline it would publish the whole queue. The platform session
 *   keeps the current item, its metadata and the transport controls; it has no queue.
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
        /** The [ControllerKey] token from the controller's connection hints, if any. */
        val connectionToken: String? = null,
    )

    /** What a controller is given (see the class comment). */
    enum class Grant {
        /** The JukePlayer plugin: every player command plus the private queue commands. */
        PLUGIN,

        /** Auto, Automotive, trusted system controllers: player commands, no queue commands. */
        FULL,

        /** The media notification (and so the platform session): FULL minus the timeline. */
        NOTIFICATION,

        /** Everyone else: [TRANSPORT_COMMANDS], no session commands. */
        TRANSPORT,
    }

    /** Android's first app uid (Process.FIRST_APPLICATION_UID); below it are core system uids. */
    private const val FIRST_APPLICATION_UID = 10_000

    /** UserHandle.PER_USER_RANGE: a uid is userId * this + appId (UserHandle.getAppId). */
    private const val PER_USER_RANGE = 100_000

    /** System UI runs with an app uid but holds STATUS_BAR_SERVICE. */
    private val SYSTEM_UI_PACKAGES = setOf("com.android.systemui")

    fun access(c: Controller, ownPackage: String): Access {
        if (c.isMediaNotificationController || c.isAutoCompanionController || c.isAutomotiveController) {
            return Access.FULL
        }
        if (!c.isTrusted) return Access.TRANSPORT
        if (c.packageName == ownPackage) return Access.FULL
        // Core system uids exist once per user (work profile, secondary users): compare app ids.
        if (c.uid >= 0 && c.uid % PER_USER_RANGE < FIRST_APPLICATION_UID) return Access.FULL
        if (c.packageName in SYSTEM_UI_PACKAGES) return Access.FULL
        return Access.TRANSPORT
    }

    fun grant(c: Controller, ownPackage: String, processToken: String): Grant {
        if (access(c, ownPackage) == Access.TRANSPORT) return Grant.TRANSPORT
        if (c.isMediaNotificationController) return Grant.NOTIFICATION
        if (c.isTrusted && c.packageName == ownPackage && tokenMatches(c.connectionToken, processToken)) {
            return Grant.PLUGIN
        }
        return Grant.FULL
    }

    /** Only the plugin's controller may send QueueCommands and QUEUE_NEXT. */
    fun mayUseQueueCommands(c: Controller, ownPackage: String, processToken: String): Boolean =
        grant(c, ownPackage, processToken) == Grant.PLUGIN

    /** Player commands the [Grant.NOTIFICATION] controller (and the platform session) lacks. */
    val NOTIFICATION_HIDDEN_COMMANDS: Set<Int> = setOf(Player.COMMAND_GET_TIMELINE)

    /** Constant-time comparison; an empty or missing token never matches. */
    fun tokenMatches(presented: String?, expected: String): Boolean {
        if (presented.isNullOrEmpty() || expected.isEmpty()) return false
        return MessageDigest.isEqual(presented.toByteArray(), expected.toByteArray())
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
