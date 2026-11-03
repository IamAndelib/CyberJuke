package io.github.iamandelib.cyberjuke.local

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * The chosen folders and the songs found in them, kept in `no_backup/local/index.json` (never
 * backed up), and the songs' covers in `no_backup/local/art/`. Written whole and atomically
 * (a temp file, then a rename); a file that can't be read, or of another version, reads as empty.
 * Used from one thread at a time (LocalLibrary's). Pure but for the files (LocalIndexTest).
 */
internal class LocalIndex(private val dir: File) {
    /** A chosen folder: [id] is its tree URI (what Android's picker gave), [name] what it's shown as. */
    data class Folder(val id: String, val name: String)

    /**
     * A song. [uri] is its document URI under [folder]'s tree (what the player opens), [name] its
     * file name. [cover]: a cover is kept in [artFile].
     */
    data class Entry(
        val id: String,
        val folder: String,
        val uri: String,
        val name: String,
        val title: String,
        val artist: String,
        val album: String,
        val durationMs: Long,
        val size: Long,
        val modified: Long,
        val cover: Boolean,
    )

    val folders = mutableListOf<Folder>()
    val entries = LinkedHashMap<String, Entry>()

    private val file get() = File(dir, "index.json")

    fun artFile(id: String): File = File(dir, "art/${id.removePrefix("loc:")}.jpg")

    fun load() {
        folders.clear()
        entries.clear()
        val text = try {
            file.takeIf { it.isFile }?.readText() ?: return
        } catch (_: Exception) {
            return
        }
        decode(text)?.let { (f, e) ->
            folders += f
            e.forEach { entries[it.id] = it }
        }
    }

    fun save() {
        dir.mkdirs()
        val tmp = File(dir, "index.json.tmp")
        tmp.writeText(encode(folders, entries.values))
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
    }

    /** Drops [folderId] and its songs (and their covers). */
    fun removeFolder(folderId: String) {
        folders.removeAll { it.id == folderId }
        val gone = entries.values.filter { it.folder == folderId }
        gone.forEach { entries.remove(it.id); artFile(it.id).delete() }
    }

    /** Everything: the list, the covers and the folders. */
    fun clear() {
        folders.clear()
        entries.clear()
        dir.deleteRecursively()
    }

    fun songsIn(folderId: String): Int = entries.values.count { it.folder == folderId }

    companion object {
        const val VERSION = 1

        fun encode(folders: Collection<Folder>, entries: Collection<Entry>): String = JSONObject()
            .put("version", VERSION)
            .put("folders", JSONArray().apply { folders.forEach { put(JSONObject().put("id", it.id).put("name", it.name)) } })
            .put(
                "songs",
                JSONArray().apply {
                    entries.forEach {
                        put(
                            JSONObject()
                                .put("id", it.id).put("folder", it.folder).put("uri", it.uri).put("name", it.name)
                                .put("title", it.title).put("artist", it.artist).put("album", it.album)
                                .put("durationMs", it.durationMs).put("size", it.size).put("modified", it.modified)
                                .put("cover", it.cover),
                        )
                    }
                },
            )
            .toString()

        /** Null for anything that isn't this version's index; a broken song is skipped. */
        fun decode(text: String): Pair<List<Folder>, List<Entry>>? = try {
            val o = JSONObject(text)
            if (o.optInt("version") != VERSION) null else {
                val f = o.getJSONArray("folders").let { a ->
                    (0 until a.length()).mapNotNull { i ->
                        a.optJSONObject(i)?.let { j -> Folder(j.getString("id"), j.optString("name")) }
                    }
                }
                val ids = f.map { it.id }.toSet()
                val e = o.getJSONArray("songs").let { a ->
                    (0 until a.length()).mapNotNull { i -> a.optJSONObject(i)?.let { entryOf(it) } }
                }.filter { it.folder in ids }
                f to e
            }
        } catch (_: Exception) {
            null
        }

        private fun entryOf(j: JSONObject): Entry? = try {
            Entry(
                id = j.getString("id").takeIf { LocalRules.isId(it) } ?: return null,
                folder = j.getString("folder"),
                uri = j.getString("uri"),
                name = j.optString("name"),
                title = j.getString("title"),
                artist = j.getString("artist"),
                album = j.optString("album"),
                durationMs = j.optLong("durationMs"),
                size = j.optLong("size"),
                modified = j.optLong("modified"),
                cover = j.optBoolean("cover"),
            )
        } catch (_: Exception) {
            null
        }
    }
}
