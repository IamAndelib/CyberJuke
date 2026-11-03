package io.github.iamandelib.cyberjuke.local

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.util.Log
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.Executors

/**
 * Looks through one chosen folder: only that tree, through Android's own document queries
 * (never DocumentFile, which asks again for every file, and never the music index), skipping
 * hidden names. Only new or changed files are read (LocalRules.needsRead); their tags come from
 * Android's MediaMetadataRetriever, on two threads. Covers: the embedded picture, else the
 * folder's cover.jpg / folder.jpg / front.jpg, shrunk to [COVER_PX]. Logs name the error's type
 * only, never a file, folder or tag.
 */
internal class LocalScanner(private val context: Context) {
    @Volatile
    var cancelled = false

    /** One file to read: [id], its document [uri], its [child] row, and its folder's cover file if any. */
    private class Pending(val id: String, val uri: String, val child: Child, val coverUri: String?)

    private class Child(val docId: String, val name: String, val mime: String?, val size: Long, val modified: Long)

    /** What a scan found: the folder's songs, keyed by id. Null when the folder couldn't be reached or the scan was stopped. */
    fun scan(folder: LocalIndex.Folder, known: Map<String, LocalIndex.Entry>, artFile: (String) -> File, found: (Int) -> Unit): Map<String, LocalIndex.Entry>? {
        val tree = Uri.parse(folder.id)
        val authority = tree.authority ?: return null
        val out = HashMap<String, LocalIndex.Entry>()
        val pending = ArrayList<Pending>()
        try {
            val rootId = DocumentsContract.getTreeDocumentId(tree)
            val dirs = ArrayDeque<Pair<String, Int>>().apply { add(rootId to 0) }
            while (dirs.isNotEmpty()) {
                if (cancelled) return null
                val (dirId, depth) = dirs.removeFirst()
                val kids = children(tree, dirId) ?: if (dirId == rootId) return null else continue
                val cover = LocalRules.coverName(kids.filter { it.mime != Document.MIME_TYPE_DIR }.map { it.name })
                    ?.let { name -> kids.first { it.name == name } }
                    ?.let { DocumentsContract.buildDocumentUriUsingTree(tree, it.docId).toString() }
                for (k in kids) {
                    if (LocalRules.isHidden(k.name)) continue
                    if (k.mime == Document.MIME_TYPE_DIR) {
                        if (depth < MAX_DEPTH) dirs.add(k.docId to depth + 1)
                        continue
                    }
                    if (!LocalRules.isAudio(k.mime, k.name)) continue
                    val id = LocalRules.idOf(authority, k.docId)
                    val uri = DocumentsContract.buildDocumentUriUsingTree(tree, k.docId).toString()
                    val old = known[id]
                    if (LocalRules.needsRead(old, k.size, k.modified)) {
                        pending += Pending(id, uri, k, cover)
                    } else {
                        // The same file, perhaps reached through a newly chosen folder that holds the old one.
                        out[id] = old!!.copy(folder = folder.id, uri = uri)
                    }
                }
                found(out.size)
            }
        } catch (e: Exception) {
            // No access any more (a card taken out, access taken back in Android), or a provider that failed.
            Log.w(TAG, "scan failed: ${e.javaClass.simpleName}")
            return null
        }
        if (pending.isNotEmpty()) {
            val pool = Executors.newFixedThreadPool(READERS) { r -> Thread(r, "JukeLocalTags").apply { isDaemon = true } }
            try {
                val jobs = pending.map { p -> Callable { if (cancelled) null else read(p, folder.id, artFile(p.id)) } }
                for (f in pool.invokeAll(jobs)) {
                    val e = try { f.get() } catch (_: Exception) { null } ?: continue
                    out[e.id] = e
                    if (out.size % PROGRESS_EVERY == 0) found(out.size)
                }
            } finally {
                pool.shutdownNow()
            }
            if (cancelled) return null
        }
        found(out.size)
        return out
    }

    /** A folder's children, or null when it can't be read. A provider still loading is asked once more. */
    private fun children(tree: Uri, docId: String): List<Child>? {
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
        for (attempt in 0..1) {
            val c = context.contentResolver.query(uri, PROJECTION, null, null, null) ?: return null
            c.use {
                if (attempt == 0 && it.extras?.getBoolean(DocumentsContract.EXTRA_LOADING) == true) {
                    Thread.sleep(LOADING_WAIT_MS)
                } else {
                    val list = ArrayList<Child>(it.count)
                    while (it.moveToNext()) {
                        list += Child(
                            docId = it.getString(0) ?: continue,
                            name = it.getString(1) ?: "",
                            mime = it.getString(2),
                            size = if (it.isNull(3)) -1 else it.getLong(3),
                            modified = if (it.isNull(4)) -1 else it.getLong(4),
                        )
                    }
                    return list
                }
            }
        }
        return null
    }

    private fun read(p: Pending, folderId: String, art: File): LocalIndex.Entry {
        var title: String? = null
        var artist: String? = null
        var albumArtist: String? = null
        var album: String? = null
        var track: String? = null
        var disc: String? = null
        var year: String? = null
        var date: String? = null
        var duration = 0L
        var picture: ByteArray? = null
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(context, Uri.parse(p.uri))
            title = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)
            artist = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST)
            albumArtist = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST)
            album = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM)
            track = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER)
            disc = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DISC_NUMBER)
            year = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_YEAR)
            date = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DATE)
            duration = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            picture = r.embeddedPicture
        } catch (e: Exception) {
            // Tags that can't be read: the file's name stands in.
            Log.i(TAG, "tags unreadable: ${e.javaClass.simpleName}")
        } finally {
            try {
                r.release()
            } catch (_: Exception) {
            }
        }
        val cover = writeCover(picture ?: p.coverUri?.let { readSmall(it) }, art)
        return LocalIndex.Entry(
            id = p.id,
            folder = folderId,
            uri = p.uri,
            name = p.child.name,
            title = LocalRules.shownTitle(title, p.child.name),
            artist = LocalRules.shownArtist(artist, albumArtist),
            album = album?.trim().orEmpty(),
            albumArtist = albumArtist?.trim().orEmpty(),
            track = LocalRules.number(track),
            disc = LocalRules.number(disc),
            year = LocalRules.year(year).takeIf { it > 0 } ?: LocalRules.year(date),
            durationMs = duration,
            size = p.child.size,
            modified = p.child.modified,
            cover = cover,
        )
    }

    /** A folder cover's bytes, unless it is bigger than a cover should be. */
    private fun readSmall(uri: String): ByteArray? = try {
        context.contentResolver.openInputStream(Uri.parse(uri))?.use { s ->
            val buf = s.readNBytesCompat(MAX_COVER_BYTES + 1)
            buf.takeIf { it.size <= MAX_COVER_BYTES }
        }
    } catch (_: Exception) {
        null
    }

    /** Writes [bytes] as a JPEG of at most [COVER_PX] to [art]; false (and no file) without a picture. */
    private fun writeCover(bytes: ByteArray?, art: File): Boolean {
        if (bytes == null) {
            art.delete()
            return false
        }
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= COVER_PX && bounds.outHeight / (sample * 2) >= COVER_PX) sample *= 2
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                ?: return false.also { art.delete() }
            val scale = COVER_PX.toFloat() / maxOf(bmp.width, bmp.height)
            val out = if (scale < 1f) Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt().coerceAtLeast(1), (bmp.height * scale).toInt().coerceAtLeast(1), true) else bmp
            art.parentFile?.mkdirs()
            val tmp = File(art.parentFile, art.name + ".tmp")
            tmp.outputStream().use { out.compress(Bitmap.CompressFormat.JPEG, 85, it) }
            if (out !== bmp) out.recycle()
            bmp.recycle()
            tmp.renameTo(art)
        } catch (e: Exception) {
            Log.i(TAG, "cover unreadable: ${e.javaClass.simpleName}")
            art.delete()
            false
        }
    }

    private fun java.io.InputStream.readNBytesCompat(n: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (out.size() < n) {
            val r = read(buf, 0, minOf(buf.size, n - out.size()))
            if (r < 0) break
            out.write(buf, 0, r)
        }
        return out.toByteArray()
    }

    companion object {
        private const val TAG = "CyberJukeLocal"
        private val PROJECTION = arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE,
            Document.COLUMN_LAST_MODIFIED,
        )
        /** Tags are read on this many threads (more only if a phone's first look measures slow). */
        private const val READERS = 2
        private const val MAX_DEPTH = 24
        private const val PROGRESS_EVERY = 25
        private const val LOADING_WAIT_MS = 500L
        const val COVER_PX = 512
        private const val MAX_COVER_BYTES = 8 shl 20
    }
}
