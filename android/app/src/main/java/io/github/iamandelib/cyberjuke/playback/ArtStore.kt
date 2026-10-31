package io.github.iamandelib.cyberjuke.playback

import okhttp3.Call
import okhttp3.Request
import java.io.File
import java.io.IOException

/**
 * The covers of the liked songs saved on the phone, as plain files in no_backup/art (never
 * backed up), so Liked, Now Playing and the lock screen show them offline, as music players
 * that keep downloads do (Metrolist, InnerTune). A video's two frames are kept: the small one
 * rows show and the big one Now Playing and the notification show (src/data/model artworkUrl,
 * smallArt). [LikedSaver] fetches them once a song is saved, on the networks it saves on;
 * the page's images ([io.github.iamandelib.cyberjuke.bridge.ArtWebViewClient]) and the
 * notification's ([SavedArtBitmapLoader]) are served from here when there. Pure but for the
 * files and the fetch (ArtStoreTest).
 */
internal object ArtStore {
    private val FRAME = Regex("^https://i\\.ytimg\\.com/vi/([A-Za-z0-9_-]{11})/(hq|mq)default\\.jpg$")

    /** A cover is a small image: anything bigger isn't kept. */
    const val MAX_BYTES = 1L shl 20

    /** The covers a saved song keeps: its video's frames (a Jukebox MP3 has none from its id). */
    fun coversOf(audioId: String): List<String> =
        if (SessionPolicy.isValidYtId(audioId)) listOf("hq", "mq").map { "https://i.ytimg.com/vi/$audioId/${it}default.jpg" } else emptyList()

    /** The file a cover is kept under (`<video>-hq.jpg`), or null for any URL that isn't a frame this keeps. */
    fun nameFor(url: String): String? = FRAME.matchEntire(url)?.let { "${it.groupValues[1]}-${it.groupValues[2]}.jpg" }

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

        /** Every cover but those of [audioIds] goes (songs no longer liked), half-written ones too. */
        fun keepOnly(audioIds: Set<String>) {
            val keep = audioIds.flatMap { coversOf(it) }.mapNotNullTo(HashSet()) { nameFor(it) }
            dir.listFiles()?.forEach { if (it.name !in keep) it.delete() }
        }

        /** [audioId]'s covers go. */
        fun remove(audioId: String) {
            coversOf(audioId).mapNotNull { nameFor(it) }.forEach { File(dir, it).delete() }
        }
    }
}
