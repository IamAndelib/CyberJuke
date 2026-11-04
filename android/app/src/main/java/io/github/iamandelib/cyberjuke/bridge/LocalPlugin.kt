package io.github.iamandelib.cyberjuke.bridge

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.storage.StorageManager
import android.provider.DocumentsContract
import android.util.Log
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import io.github.iamandelib.cyberjuke.local.LocalIndex
import io.github.iamandelib.cyberjuke.local.LocalLibrary
import io.github.iamandelib.cyberjuke.local.LocalRules
import io.github.iamandelib.cyberjuke.local.LocalScanner
import io.github.iamandelib.cyberjuke.playback.BridgeLimits
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Local music: the folders the person chose with Android's folder picker, and the songs in them
 * (docs/superpowers/specs/2026-11-03-local-music-design.md). Only those trees are ever read, so
 * the app needs no storage permission. Contract (TS side, src/data/local.ts):
 *
 *   interface LocalFolder { id: string; name: string; songs: number; state: 'ok' | 'scanning' | 'gone' }
 *   interface LocalSong { id: string; title: string; artist: string; album: string;
 *     albumArtist: string; track: number; disc: number; year: number;   // "" / 0 when unknown
 *     durationMs: number; modified: number; folder: string; cover: boolean }   // modified: ms, 0 unknown
 *   folders(): Promise<{ folders: LocalFolder[] }>
 *   addFolder({ initial?: folder id }): Promise<{ result: 'added' | 'inside' | 'cancelled';
 *     folder?: LocalFolder; name?: string }>   // inside: the folder it is in, by name
 *   removeFolder({ id }): Promise<void>   // gives the folder's access back, drops its songs
 *   tracks(): Promise<{ tracks: LocalSong[] }>
 *   scan(): Promise<void>   // starts a look through every folder; progress as localChanged
 *   setEnabled({ on: false }): Promise<void>   // gives every folder's access back, deletes the list and covers
 *   event localChanged { scanning: folder id | null; found: number; done: boolean }
 *
 * A folder id is the tree URI the picker gave; the page only ever passes back ids it was given,
 * and each is checked against the chosen folders. Scans run one at a time on their own thread.
 */
@CapacitorPlugin(name = "JukeLocal")
class LocalPlugin : Plugin() {
    private val scans = Executors.newSingleThreadExecutor { r -> Thread(r, "JukeLocalScan").apply { isDaemon = true } }
    private val calls = Executors.newSingleThreadExecutor { r -> Thread(r, "JukeLocal").apply { isDaemon = true } }

    /** Folders whose last look failed (no access, card out). */
    private val unreachable = ConcurrentHashMap.newKeySet<String>()

    @Volatile
    private var scanning: String? = null

    @Volatile
    private var scanner: LocalScanner? = null

    /** The page is gone (the activity recreated): a running scan stops, and the next page's plugin scans again. */
    @Volatile
    private var stopped = false

    override fun load() {
        calls.execute { LocalLibrary.init(context) }
    }

    @PluginMethod
    fun folders(call: PluginCall) {
        calls.execute { call.resolve(JSObject().put("folders", foldersJson())) }
    }

    @PluginMethod
    fun addFolder(call: PluginCall) {
        val initial = try {
            BridgeLimits.checkString(call.getString("initial"), "initial")
        } catch (e: Exception) {
            call.reject("UNAVAILABLE")
            return
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        if (initial != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && LocalLibrary.edit(context, save = false) { i -> i.folders.any { it.id == initial } }) {
            intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri.parse(initial))
        }
        try {
            startActivityForResult(call, intent, "folderPicked")
        } catch (e: ActivityNotFoundException) {
            // No folder picker on this device (some TVs and locked-down profiles).
            call.reject("UNAVAILABLE")
        }
    }

    @ActivityCallback
    private fun folderPicked(call: PluginCall?, result: ActivityResult) {
        call ?: return
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            call.resolve(JSObject().put("result", "cancelled"))
            return
        }
        try {
            context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (e: Exception) {
            Log.w(TAG, "folder access refused: ${e.javaClass.simpleName}")
            call.reject("UNAVAILABLE")
            return
        }
        calls.execute { addPicked(call, uri) }
    }

    private fun addPicked(call: PluginCall, uri: Uri) {
        val id = uri.toString()
        val ref = refOf(id) ?: run {
            release(id)
            call.reject("UNAVAILABLE")
            return
        }
        val name = displayName(uri)
        val outcome = LocalLibrary.edit(context) { i ->
            val same = i.folders.firstOrNull { it.id == id }
            val outer = i.folders.firstOrNull { f -> f.id != id && refOf(f.id)?.let { LocalRules.relation(ref, it) } == LocalRules.Relation.INSIDE }
            when {
                // Chosen again (after "Can't reach this folder"): the same folder, looked through again.
                same != null -> same
                outer != null -> outer.name
                else -> {
                    val inner = i.folders.filter { f -> refOf(f.id)?.let { LocalRules.relation(ref, it) } == LocalRules.Relation.CONTAINS }
                    // The folders it holds go: their songs are found again under it, with the same ids.
                    i.folders.removeAll(inner.toSet())
                    inner.forEach { release(it.id); unreachable.remove(it.id) }
                    LocalIndex.Folder(id, name).also { i.folders += it }
                }
            }
        }
        when (outcome) {
            is String -> {
                release(id)
                call.resolve(JSObject().put("result", "inside").put("name", outcome))
            }
            is LocalIndex.Folder -> {
                unreachable.remove(outcome.id)
                call.resolve(JSObject().put("result", "added").put("folder", folderJson(outcome)))
                startScan(listOf(outcome.id))
            }
        }
    }

    @PluginMethod
    fun removeFolder(call: PluginCall) {
        val id = call.getString("id")
        calls.execute {
            val known = id != null && LocalLibrary.edit(context) { i ->
                (i.folders.any { it.id == id }).also { if (it) i.removeFolder(id!!) }
            }
            if (known) {
                if (scanning == id) scanner?.cancelled = true
                release(id!!)
                unreachable.remove(id)
                emit(done = scanning == null)
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun tracks(call: PluginCall) {
        calls.execute {
            val arr = JSArray()
            LocalLibrary.songs.values.forEach { e ->
                arr.put(
                    JSObject()
                        .put("id", e.id).put("title", e.title).put("artist", e.artist).put("album", e.album)
                        .put("albumArtist", e.albumArtist).put("track", e.track).put("disc", e.disc).put("year", e.year)
                        .put("durationMs", e.durationMs).put("modified", maxOf(0L, e.modified))
                        .put("folder", e.folder).put("cover", e.cover),
                )
            }
            call.resolve(JSObject().put("tracks", arr))
        }
    }

    @PluginMethod
    fun scan(call: PluginCall) {
        call.resolve()
        startScan(null)
    }

    @PluginMethod
    fun setEnabled(call: PluginCall) {
        if (call.getBoolean("on", true) == true) {
            call.resolve()
            return
        }
        scanner?.cancelled = true
        calls.execute {
            LocalLibrary.edit(context) { i ->
                i.folders.forEach { release(it.id) }
                i.clear()
            }
            unreachable.clear()
            call.resolve()
        }
    }

    /** Looks through [ids] (null: every folder), one after another, after any scan already queued. */
    private fun startScan(ids: List<String>?) {
        scans.execute {
            val folders = LocalLibrary.edit(context, save = false) { i -> i.folders.filter { ids == null || it.id in ids } }
            for (f in folders) {
                if (stopped) break
                val s = LocalScanner(context.applicationContext).also { scanner = it }
                scanning = f.id
                emit(found = 0, done = false)
                val known = LocalLibrary.songs
                val found = s.scan(f, known, { id -> LocalLibrary.edit(context, save = false) { it.artFile(id) } }) { n -> emit(found = n, done = false) }
                if (found == null) {
                    if (!s.cancelled) unreachable.add(f.id)
                } else {
                    unreachable.remove(f.id)
                    LocalLibrary.edit(context) { i ->
                        // Still chosen (not removed meanwhile): its songs become what was found.
                        if (i.folders.any { it.id == f.id }) {
                            val gone = i.entries.values.filter { it.folder == f.id && it.id !in found }
                            gone.forEach { i.entries.remove(it.id); i.artFile(it.id).delete() }
                            // Songs found again through this folder leave the folder they were under.
                            i.entries.putAll(found)
                        }
                    }
                }
            }
            // Covers written for songs that never made it into the list (their folder removed, or local
            // music turned off, while they were read) go; with nothing chosen any more, everything goes.
            // Not once stopped: the next page's scan may be writing covers for songs not listed yet.
            if (!stopped) LocalLibrary.edit(context) { it.dropStrayArt() }
            scanning = null
            scanner = null
            if (!stopped) emit(done = true)
        }
    }

    override fun handleOnDestroy() {
        stopped = true
        scanner?.cancelled = true
        scans.shutdown()
        calls.shutdown()
    }

    private fun emit(found: Int = 0, done: Boolean) {
        notifyListeners(
            "localChanged",
            JSObject().put("scanning", scanning ?: JSONObject.NULL).put("found", found).put("done", done),
        )
    }

    private fun foldersJson(): JSArray = JSArray().apply {
        LocalLibrary.edit(context, save = false) { i -> i.folders.toList() }.forEach { put(folderJson(it)) }
    }

    private fun folderJson(f: LocalIndex.Folder): JSObject = JSObject()
        .put("id", f.id)
        .put("name", f.name)
        .put("songs", LocalLibrary.songs.values.count { it.folder == f.id })
        .put(
            "state",
            when {
                f.id == scanning -> "scanning"
                f.id in unreachable || !granted(f.id) -> "gone"
                else -> "ok"
            },
        )

    private fun granted(id: String): Boolean =
        context.contentResolver.persistedUriPermissions.any { it.uri.toString() == id && it.isReadPermission }

    private fun release(id: String) {
        try {
            context.contentResolver.releasePersistableUriPermission(Uri.parse(id), Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: Exception) {
            // Not held (any more): nothing to give back.
        }
    }

    private fun refOf(treeUri: String): LocalRules.TreeRef? = try {
        val u = Uri.parse(treeUri)
        LocalRules.TreeRef(u.authority ?: return null, DocumentsContract.getTreeDocumentId(u))
    } catch (_: Exception) {
        null
    }

    /** "Music" on the phone's own storage; "SD card › Albums" (the volume's own name) elsewhere. */
    private fun displayName(tree: Uri): String {
        val rootId = try {
            DocumentsContract.getTreeDocumentId(tree)
        } catch (_: Exception) {
            return "Folder"
        }
        val name = try {
            val doc = DocumentsContract.buildDocumentUriUsingTree(tree, rootId)
            context.contentResolver.query(doc, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) it.getString(0) else null
            }
        } catch (_: Exception) {
            null
        }
        val volume = rootId.substringBefore(':', "")
        val path = rootId.substringAfter(':', "")
        val label = if (tree.authority == EXTERNAL_STORAGE && volume.isNotEmpty() && volume != "primary") volumeLabel(volume) else null
        return when {
            label != null && path.isEmpty() -> label
            label != null -> "$label › ${name ?: path.substringAfterLast('/')}"
            else -> name ?: path.substringAfterLast('/').ifEmpty { "Folder" }
        }
    }

    private fun volumeLabel(uuid: String): String? = try {
        val sm = context.getSystemService(StorageManager::class.java)
        sm?.storageVolumes?.firstOrNull { it.uuid.equals(uuid, ignoreCase = true) }?.getDescription(context)
    } catch (_: Exception) {
        null
    }

    companion object {
        private const val TAG = "CyberJukeLocal"
        private const val EXTERNAL_STORAGE = "com.android.externalstorage.documents"
    }
}
