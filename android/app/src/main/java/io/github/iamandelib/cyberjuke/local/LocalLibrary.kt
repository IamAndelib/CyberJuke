package io.github.iamandelib.cyberjuke.local

import android.content.Context
import android.util.Log
import java.io.File

/**
 * The one [LocalIndex] of the process, shared by the JukeLocal plugin (folders, scans) and the
 * player (which file a `loc:` id is). Every change goes through [edit], under one lock; [songs]
 * is an immutable snapshot taken after each change, so the player reads it without the lock.
 */
internal object LocalLibrary {
    @Volatile
    private var index: LocalIndex? = null

    /** The songs by id, as of the last change. */
    @Volatile
    var songs: Map<String, LocalIndex.Entry> = emptyMap()
        private set

    private fun indexOf(context: Context): LocalIndex =
        index ?: LocalIndex(File(context.applicationContext.noBackupFilesDir, "local")).also {
            it.load()
            index = it
            songs = it.entries.toMap()
        }

    /** Loads the index on first use (from any thread). */
    fun init(context: Context) {
        synchronized(this) { indexOf(context) }
    }

    /** Runs [block] on the index under the lock; when [save], writes the file and takes a new [songs] snapshot. */
    fun <T> edit(context: Context, save: Boolean = true, block: (LocalIndex) -> T): T = synchronized(this) {
        val i = indexOf(context)
        val r = block(i)
        if (save) {
            if (i.folders.isEmpty() && i.entries.isEmpty()) i.clear() else if (!i.save()) Log.w(TAG, "index not saved")
            songs = i.entries.toMap()
        }
        r
    }

    /**
     * A song's cover file, when one is kept (null before the index is loaded). No lock: the
     * notification asks for covers on the main thread, which mustn't wait for a save.
     */
    fun coverFile(id: String): File? = index?.artFile(id)?.takeIf { songs[id]?.cover == true && it.isFile }

    private const val TAG = "CyberJukeLocal"
}
