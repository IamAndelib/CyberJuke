package io.github.iamandelib.cyberjuke.playback

import okhttp3.Call
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * The covers of the liked songs saved on the phone, as plain files in no_backup/art (never
 * backed up), so Liked, Now Playing and the lock screen show them offline, as music players
 * that keep downloads do (Metrolist, InnerTune). A video's two frames are kept: the small one
 * rows show and the big one Now Playing and the notification show (src/data/model artworkUrl,
 * smallArt); a Jukebox MP3 keeps the cover the page sends with Liked ([setMp3Covers]). [LikedSaver] fetches them once a song is saved, on the networks it saves on;
 * the page's images ([io.github.iamandelib.cyberjuke.bridge.ArtWebViewClient]) and the
 * notification's ([SavedArtBitmapLoader]) are served from here when there. Pure but for the
 * files and the fetch (ArtStoreTest).
 */
internal object ArtStore {
    private val FRAME = Regex("^https://i\\.ytimg\\.com/vi/([A-Za-z0-9_-]{11})/(hq|mq)default\\.jpg$")

    /** A cover is a small image: anything bigger isn't kept. */
    const val MAX_BYTES = 1L shl 20

    /** A Jukebox MP3's cover is kept as `c-<hash of its URL>`. */
    private const val COVER_PREFIX = "c-"

    /** Each liked Jukebox MP3's cover, by audio id, as the page last sent it (setLikedIds). */
    @Volatile
    private var mp3Covers: Map<String, String> = emptyMap()

    /** Whether the page has sent them since the process started: until then no MP3 cover is taken. */
    @Volatile
    private var coversKnown = false

    /** The page's covers: only an MP3's, and only one from the site ([SessionPolicy.isAllowedArtwork]). */
    fun setMp3Covers(covers: Map<String, String>) {
        mp3Covers = covers.filter { (id, url) -> SessionPolicy.mp3FileOfAudioId(id) != null && isCover(url) }
        coversKnown = true
    }

    /** As at a fresh start (tests). */
    fun forgetMp3Covers() {
        mp3Covers = emptyMap()
        coversKnown = false
    }

    /** The covers a saved song keeps: its video's frames, or the cover the page sent for a Jukebox MP3. */
    fun coversOf(audioId: String): List<String> =
        if (SessionPolicy.isValidYtId(audioId)) listOf("hq", "mq").map { "https://i.ytimg.com/vi/$audioId/${it}default.jpg" } else listOfNotNull(mp3Covers[audioId])

    /** The file a cover is kept under (`<video>-hq.jpg`, `c-<hash>`), or null for any URL this doesn't keep. */
    fun nameFor(url: String): String? = FRAME.matchEntire(url)?.let { "${it.groupValues[1]}-${it.groupValues[2]}.jpg" }
        ?: url.takeIf { isCover(it) }?.let { COVER_PREFIX + sha256(it).take(32) }

    private fun isCover(url: String) = url.startsWith("https://bunker.cyberspace.online/") && SessionPolicy.isAllowedArtwork(url)

    private fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    /** The folder, once the app or the service has started. */
    @Volatile
    var files: Files? = null
        private set

    fun init(dir: File) {
        if (files == null) files = Files(dir)
    }

    /** The covers in [dir]. Any thread; nothing here holds a lock (a file is renamed into place whole). */
    class Files(private val dir: File) {
        /** The cover kept for a [method] request of [url], or null (fetch it). */
        fun fileFor(method: String, url: String): File? =
            if (method != "GET") null else nameFor(url)?.let { File(dir, it) }?.takeIf { it.isFile }

        /** Of [audioId]'s covers, those not on the phone yet. */
        fun missing(audioId: String): List<String> = coversOf(audioId).filter { fileFor("GET", it) == null }

        /** Fetches [url] into place through [client]; false if it couldn't be (the caller tries again another time). */
        @Throws(IOException::class)
        fun fetch(url: String, client: Call.Factory): Boolean {
            val name = nameFor(url) ?: return false
            dir.mkdirs()
            val part = File(dir, "$name.part")
            client.newCall(Request.Builder().url(url).build()).execute().use { r ->
                val body = r.body
                if (!r.isSuccessful || body == null || body.contentLength() > MAX_BYTES) return false
                val bytes = body.source().use { src ->
                    if (src.request(MAX_BYTES + 1)) return false
                    src.readByteArray()
                }
                part.writeBytes(bytes)
            }
            return part.renameTo(File(dir, name))
        }

        /**
         * Every cover but those of [audioIds] goes (songs no longer liked), half-written ones too;
         * an MP3's only once the page has said which it has ([setMp3Covers]).
         */
        fun keepOnly(audioIds: Set<String>) {
            val keep = audioIds.flatMap { coversOf(it) }.mapNotNullTo(HashSet()) { nameFor(it) }
            val known = coversKnown
            dir.listFiles()?.forEach { if (it.name !in keep && (known || !it.name.startsWith(COVER_PREFIX) || it.name.endsWith(".part"))) it.delete() }
        }

        /** [audioId]'s covers go. */
        fun remove(audioId: String) {
            coversOf(audioId).mapNotNull { nameFor(it) }.forEach { File(dir, it).delete() }
        }
    }
}
