package io.github.iamandelib.cyberjuke.playback

import java.io.File

/**
 * Where the listening cache keeps its files: the [AudioCache] folder and its two id lists, in
 * the app's no-backup folder (Context.noBackupFilesDir), which Android never clears and never
 * backs up. Metrolist keeps its caches in filesDir for the same reason.
 *
 * Their first home was the cache folder (Context.cacheDir), which Android empties by itself when
 * storage runs low, oldest files first: the SimpleCache's `.uid` file is among the first to go,
 * and without it the next start drops every saved song. [move] brings them over once, before the
 * cache opens. Pure (CacheHomeTest).
 */
internal object CacheHome {
    /** The SimpleCache folder. */
    const val DIR = "audio"

    /** The liked list, newest first. */
    const val LIKED_FILE = "audio-liked"

    /** The tags of members-only audio in the cache. */
    const val MEMBERS_FILE = "audio-members"

    /** What [move] brings over. */
    val NAMES = listOf(DIR, LIKED_FILE, MEMBERS_FILE)

    enum class Step {
        /** Only in the old home: move it there. */
        MIGRATE,

        /** In neither: start empty. */
        FRESH,

        /** Already in the new home: use it (a copy left in the old one goes). */
        IN_PLACE,
    }

    fun plan(oldExists: Boolean, newExists: Boolean): Step = when {
        newExists -> Step.IN_PLACE
        oldExists -> Step.MIGRATE
        else -> Step.FRESH
    }

    /**
     * Moves each of [NAMES] from [oldRoot] to [newRoot] by [plan]. A rename stays on the same disk,
     * so it is instant, and the folder keeps its `.uid` file, so the cache's index (in the
     * database) still fits it. A rename that fails, or an old copy left beside a new one, is
     * deleted ([deleteDir] for the folder, which drops its index too) and that part starts empty.
     * False when something couldn't be moved.
     */
    fun move(
        oldRoot: File,
        newRoot: File,
        deleteDir: (File) -> Unit,
        rename: (File, File) -> Boolean = { from, to -> from.renameTo(to) },
    ): Boolean {
        var moved = true
        for (name in NAMES) {
            val old = File(oldRoot, name)
            val oldExists = old.exists()
            val drop = when (plan(oldExists, File(newRoot, name).exists())) {
                Step.MIGRATE -> {
                    val ok = rename(old, File(newRoot, name))
                    if (!ok) moved = false
                    !ok
                }
                Step.IN_PLACE -> oldExists
                Step.FRESH -> false
            }
            if (drop) {
                if (name == DIR) deleteDir(old) else old.delete()
            }
        }
        return moved
    }
}
