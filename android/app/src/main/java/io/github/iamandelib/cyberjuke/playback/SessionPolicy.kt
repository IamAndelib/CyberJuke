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
 * - the media notification controller, Android Auto (companion) and Automotive, when Media3 has
 *   verified the package name they go by (ControllerInfo.isPackageNameVerified);
 * - trusted system controllers: Media3 trusts them (MEDIA_CONTENT_CONTROL, STATUS_BAR_SERVICE,
 *   the system uid) AND they run as a core system uid or are System UI.
 * Everyone else (including apps trusted only because they are notification listeners) gets
 * transport commands only: play/pause, seek, next/previous, stop, plus reading the current
 * item. No timeline (the whole queue), no playlist metadata, no media item edits, no
 * shuffle/repeat/speed/volume changes and no custom commands.
 *
 * Within FULL, [grant] narrows two controllers further:
 * - The private queue commands ([QueueCommands]) go only to the JukePlayer plugin's
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
        /**
         * Media3 checked [packageName] against [uid] (ControllerInfo.isPackageNameVerified). It
         * tells the three controllers above apart by package name alone, so they count only then.
         */
        val packageNameVerified: Boolean = false,
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
        // Media3 recognises these three by package name, so only a verified one counts.
        if (c.packageNameVerified && (c.isMediaNotificationController || c.isAutoCompanionController || c.isAutomotiveController)) {
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

    /** Only the plugin's controller may send [QueueCommands]. */
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

    // ---- media items coming in from a controller (onAddMediaItems / onSetMediaItems) ----------

    private val YT_ID = Regex("^[A-Za-z0-9_-]{11}$")

    fun isValidYtId(id: String?): Boolean = id != null && YT_ID.matches(id)

    /** A Jukebox MP3 (Cyberspace 4.0): a latex.gg share link, the only kind the site accepts. */
    private val MP3_URL = Regex("^https://latex\\.gg/share/([A-Za-z0-9_-]+\\.mp3)$", RegexOption.IGNORE_CASE)

    fun isValidMp3Url(url: String?): Boolean = url != null && MP3_URL.matches(url)

    /** The file name of a Jukebox MP3 link ("IZq8cMcx.mp3"), or null when it isn't one. */
    fun mp3FileOf(url: String?): String? = url?.let { MP3_URL.matchEntire(it)?.groupValues?.get(1) }

    /** A Jukebox MP3's file name as it comes back in our own URI. */
    private val MP3_FILE = Regex("^[A-Za-z0-9_-]+\\.mp3$", RegexOption.IGNORE_CASE)

    fun isValidMp3File(file: String?): Boolean = file != null && MP3_FILE.matches(file)

    /** The one URL of a Jukebox MP3 file name ([mp3FileOf]'s inverse), or null for anything else. */
    fun mp3UrlForFile(file: String?): String? = file?.takeIf { isValidMp3File(it) }?.let { "https://latex.gg/share/$it" }

    /**
     * An item's MP3 link ([JukeUris.mp3UrlOf]): the one its URI gives ([uriLink]) when it has a
     * URI ([hasUri]), else none for a video (a [ytIdExtra]), else the one kept in TrackExtras
     * ([keptLink]). Never from the metadata, which other apps can read.
     */
    fun mp3LinkOf(hasUri: Boolean, uriLink: String?, ytIdExtra: String?, keptLink: String?): String? = when {
        hasUri -> uriLink
        ytIdExtra != null -> null
        else -> keptLink?.takeIf { isValidMp3Url(it) }
    }

    /** What a track from the page plays ([playableOf]). */
    sealed class Playable {
        data class Yt(val id: String) : Playable()

        /** A Jukebox MP3, by its latex.gg file name (its URL is rebuilt from it, [mp3UrlForFile]). */
        data class Mp3(val file: String) : Playable()
    }

    /**
     * What a NativeTrack with these fields ("" read as null) plays: a video when it has a
     * ytId, which then wins over any `mp3`; an MP3 only with no ytId at all. Throws
     * IllegalArgumentException naming the bad field (never its value).
     */
    fun playableOf(ytId: String?, mp3: String?): Playable = when {
        ytId != null -> if (isValidYtId(ytId)) Playable.Yt(ytId) else throw IllegalArgumentException("track.ytId invalid")
        mp3 != null -> mp3FileOf(mp3)?.let { Playable.Mp3(it) } ?: throw IllegalArgumentException("track.mp3 invalid")
        else -> throw IllegalArgumentException("track.ytId missing")
    }

    /** A cover's path on Cyberspace's image server: under /uploads/, no dot segments, no escapes. */
    private val COVER_PATH = Regex("^/uploads/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$")

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

    /**
     * Artwork is only loaded from `https://i.ytimg.com/...` (video thumbnails) and
     * `https://bunker.cyberspace.online/uploads/...` (the covers of Jukebox MP3s); anything
     * else is dropped.
     */
    fun isAllowedArtwork(url: String?): Boolean {
        if (url.isNullOrEmpty()) return false
        val uri = try {
            URI(url)
        } catch (_: Exception) {
            return false
        }
        if (uri.scheme != "https" || uri.userInfo != null || !(uri.port == -1 || uri.port == 443)) return false
        return uri.host == "i.ytimg.com" ||
            (uri.host == "bunker.cyberspace.online" && COVER_PATH.matches(uri.rawPath.orEmpty()) && uri.rawQuery == null && uri.rawFragment == null)
    }
}
