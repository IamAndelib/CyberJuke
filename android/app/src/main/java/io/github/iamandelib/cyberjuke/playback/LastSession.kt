package io.github.iamandelib.cyberjuke.playback

import android.content.Context
import android.util.AtomicFile
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * What was playing: the list (with what each item is: the list, queued by you, autoplay), the
 * current track and position, shuffle and repeat, where it came from and what autoplay
 * follows. The service saves it while it runs, so the app opens on it again, paused, after it
 * was stopped, killed or crashed. Pure (LastSessionTest); [LastSessionStore] keeps it on disk.
 */
internal data class LastSession(
    val entries: List<Entry>,
    val index: Int,
    val positionMs: Long,
    /** The current track's length, when known: Now Playing shows it before the track loads. */
    val durationMs: Long,
    val shuffle: Boolean,
    /** The shuffle play order (list indices), or null. */
    val order: IntArray?,
    /** Player.REPEAT_MODE_OFF / ONE / ALL. */
    val repeat: Int,
    /** Where it came from (label, mode), as in SET_LIST. */
    val context: Pair<String, String>?,
    val seedId: String?,
    /** When it was saved (wall clock): a position saved later is newer than this list's. */
    val savedAtMs: Long = 0L,
    /** Where [entries] start in the player's whole list (a long list keeps a window of it). */
    val offset: Int = 0,
) {
    /** One track: the NativeTrack fields and its part of Up next. */
    data class Entry(
        val id: String,
        val ytId: String,
        val title: String?,
        val artist: String?,
        val artworkUrl: String?,
        val by: String?,
        val postUrl: String?,
        val section: NativeQueue.Section,
    ) {
        /** The NativeTrack JSON that [JukeTracks.toMediaItem] takes. */
        fun toNativeTrack(): JSONObject = JSONObject().apply {
            put("id", id)
            put("ytId", ytId)
            title?.let { put("title", it) }
            artist?.let { put("artist", it) }
            artworkUrl?.let { put("artworkUrl", it) }
            by?.let { put("by", it) }
            postUrl?.let { put("postUrl", it) }
        }
    }

    fun encode(): String {
        val tracks = JSONArray()
        for (e in entries) {
            tracks.put(
                e.toNativeTrack().put(
                    "k",
                    when (e.section) {
                        NativeQueue.Section.QUEUED -> "q"
                        NativeQueue.Section.AUTO -> "a"
                        NativeQueue.Section.LIST -> "l"
                    },
                ),
            )
        }
        return JSONObject().apply {
            put("v", VERSION)
            put("tracks", tracks)
            put("index", index)
            put("positionMs", positionMs)
            put("durationMs", durationMs)
            put("shuffle", shuffle)
            order?.let { put("order", JSONArray(it.toList())) }
            put("repeat", repeat)
            context?.let {
                put("label", it.first)
                put("mode", it.second)
            }
            seedId?.let { put("seedId", it) }
            put("savedAtMs", savedAtMs)
            put("offset", offset)
        }.toString()
    }

    /**
     * The position preference ([positionPref], an index in the whole list) applied: only one
     * saved no earlier than this list, for the track still at its index. Anything else (older,
     * stale, malformed) is ignored.
     */
    fun withPositionPref(pref: String?): LastSession {
        val f = pref?.split('|', limit = 5)?.takeIf { it.size == 5 } ?: return this
        val savedAt = f[3].toLongOrNull() ?: return this
        if (savedAt < savedAtMs) return this
        val index = (f[0].toIntOrNull() ?: return this) - offset
        return withPosition(index, f[4], f[1].toLongOrNull() ?: 0L, f[2].toLongOrNull() ?: 0L)
    }

    /** [atIndex] current at [positionMs] (a later position than the list's), if it is still [id]. */
    fun withPosition(atIndex: Int, id: String, positionMs: Long, durationMs: Long): LastSession {
        if (entries.getOrNull(atIndex)?.id != id) return this
        return copy(
            index = atIndex,
            positionMs = positionMs.coerceAtLeast(0L),
            durationMs = durationMs.takeIf { it > 0L } ?: if (atIndex == index) this.durationMs else 0L,
        )
    }

    // Arrays don't compare by content in a data class: compare and hash them by hand.
    override fun equals(other: Any?): Boolean = other is LastSession &&
        entries == other.entries && index == other.index && positionMs == other.positionMs &&
        durationMs == other.durationMs && shuffle == other.shuffle &&
        (order?.contentEquals(other.order) ?: (other.order == null)) && repeat == other.repeat &&
        context == other.context && seedId == other.seedId && savedAtMs == other.savedAtMs && offset == other.offset

    override fun hashCode(): Int = listOf(entries, index, positionMs, durationMs, shuffle, order?.contentHashCode(), repeat, context, seedId, savedAtMs, offset).hashCode()

    companion object {
        private const val VERSION = 1

        /** The position preference: where in the list playback is, and when that was. */
        fun positionPref(index: Int, id: String, positionMs: Long, durationMs: Long, savedAtMs: Long): String =
            "$index|${positionMs.coerceAtLeast(0L)}|${durationMs.coerceAtLeast(0L)}|$savedAtMs|$id"

        /** At most this many tracks are kept: a window around the current one. */
        const val MAX_ENTRIES = 500

        /** Of which at most this many before it (already played). */
        private const val MAX_BEFORE = 100

        /**
         * A session of the whole list: [MAX_ENTRIES] around [index] at most (the shuffle order
         * keeps the ones in the window, in its order). Null when there is nothing to keep.
         */
        fun of(
            entries: List<Entry>,
            index: Int,
            positionMs: Long,
            durationMs: Long,
            shuffle: Boolean,
            order: IntArray?,
            repeat: Int,
            context: Pair<String, String>?,
            seedId: String?,
            savedAtMs: Long = 0L,
        ): LastSession? {
            if (entries.isEmpty() || index !in entries.indices) return null
            var lo = 0
            var hi = entries.size
            if (entries.size > MAX_ENTRIES) {
                lo = (index - MAX_BEFORE).coerceIn(0, entries.size - MAX_ENTRIES)
                hi = lo + MAX_ENTRIES
            }
            val kept = order?.takeIf { QueueOrder.isPermutation(it, entries.size) }
                ?.filter { it in lo until hi }?.map { it - lo }?.toIntArray()
            return LastSession(
                entries = entries.subList(lo, hi).toList(),
                index = index - lo,
                positionMs = positionMs.coerceAtLeast(0L),
                durationMs = durationMs.coerceAtLeast(0L),
                shuffle = shuffle,
                order = kept,
                repeat = repeat,
                context = context,
                seedId = seedId,
                savedAtMs = savedAtMs,
                offset = lo,
            )
        }

        /**
         * Null for anything that isn't a session this version wrote, or one with a track it
         * can't play ([validYtId]): a broken file is dropped, never half restored.
         */
        fun decode(text: String, validYtId: (String) -> Boolean = SessionPolicy::isValidYtId): LastSession? = try {
            val o = JSONObject(text)
            if (o.optInt("v") != VERSION) return null
            val arr = o.getJSONArray("tracks")
            if (arr.length() == 0 || arr.length() > MAX_ENTRIES) return null
            val entries = (0 until arr.length()).map { i ->
                val t = arr.getJSONObject(i)
                val ytId = t.str("ytId") ?: return null
                if (!validYtId(ytId)) return null
                Entry(
                    id = t.str("id") ?: return null,
                    ytId = ytId,
                    title = t.str("title"),
                    artist = t.str("artist"),
                    artworkUrl = t.str("artworkUrl"),
                    by = t.str("by"),
                    postUrl = t.str("postUrl"),
                    section = when (t.optString("k")) {
                        "q" -> NativeQueue.Section.QUEUED
                        "a" -> NativeQueue.Section.AUTO
                        else -> NativeQueue.Section.LIST
                    },
                )
            }
            val index = o.getInt("index")
            if (index !in entries.indices) return null
            val order = o.optJSONArray("order")?.let { a -> IntArray(a.length()) { a.getInt(it) } }
                ?.takeIf { QueueOrder.isPermutation(it, entries.size) }
            val label = o.str("label")
            val mode = o.str("mode")
            LastSession(
                entries = entries,
                index = index,
                positionMs = o.optLong("positionMs", 0L).coerceAtLeast(0L),
                durationMs = o.optLong("durationMs", 0L).coerceAtLeast(0L),
                shuffle = o.optBoolean("shuffle", false),
                order = order,
                repeat = o.optInt("repeat", 0).takeIf { it in 0..2 } ?: 0,
                context = if (label != null && (mode == "radio" || mode == "list")) label to mode else null,
                seedId = o.str("seedId"),
                savedAtMs = o.optLong("savedAtMs", 0L),
                offset = o.optInt("offset", 0).coerceAtLeast(0),
            )
        } catch (e: Exception) { // not JSON, or a field of the wrong type
            null
        }

        private fun JSONObject.str(key: String): String? {
            if (!has(key) || isNull(key)) return null
            val v = opt(key) as? String ?: return null
            return v.takeIf { it.isNotEmpty() && it.length <= BridgeLimits.MAX_STRING }
        }
    }
}

/**
 * [LastSession] on disk, in the app's no-backup files (a session is no use on another phone).
 * The list is written whenever it changes (off the main thread, the newest one only, atomically,
 * so a crash mid-write leaves the previous one); the position, which changes all the time, goes
 * into a tiny preference instead.
 */
internal class LastSessionStore(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "last-session.json"))
    private val prefs = context.getSharedPreferences("last_session", Context.MODE_PRIVATE)
    private val io: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "JukeSession").apply { isDaemon = true }
    }

    /** The newest list to write (null: delete); a write already queued picks it up. */
    private val toWrite = AtomicReference<Pending?>(null)

    /** A list to write (encoded on the writer's thread), or null to delete. */
    private class Pending(val session: LastSession?)

    /** Main thread, at service start (one small file). */
    fun load(validYtId: (String) -> Boolean): LastSession? {
        val text = try {
            if (!file.baseFile.exists()) return null
            String(file.readFully(), Charsets.UTF_8)
        } catch (e: Exception) {
            Log.w(TAG, "Last session unreadable: ${e.javaClass.simpleName}")
            return null
        }
        val session = LastSession.decode(text, validYtId) ?: run {
            Log.w(TAG, "Last session invalid: dropped")
            clear()
            return null
        }
        return session.withPositionPref(prefs.getString(KEY_POSITION, null))
    }

    fun save(session: LastSession?) = enqueue(Pending(session))

    fun clear() {
        // Now, not when the file goes: a position saved for a new list meanwhile must stay.
        prefs.edit().remove(KEY_POSITION).apply()
        enqueue(Pending(null))
    }

    /** Where in the list playback is (index and id, so a stale value is ignored). */
    fun savePosition(index: Int, id: String, positionMs: Long, durationMs: Long) {
        val pref = LastSession.positionPref(index, id, positionMs, durationMs, System.currentTimeMillis())
        prefs.edit().putString(KEY_POSITION, pref).apply()
    }

    /** The service is going: what is still queued is written before it does (briefly). */
    fun close() {
        io.shutdown()
        try {
            io.awaitTermination(CLOSE_WAIT_MS, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun enqueue(p: Pending) {
        if (toWrite.getAndSet(p) != null) return // a write is queued already: it takes this one
        try {
            io.execute { write(toWrite.getAndSet(null) ?: return@execute) }
        } catch (_: Exception) { // RejectedExecutionException after close
            toWrite.set(null)
        }
    }

    private fun write(p: Pending) {
        try {
            val session = p.session
            if (session == null) {
                file.delete()
                return
            }
            val bytes = session.encode().toByteArray(Charsets.UTF_8)
            val out = file.startWrite()
            try {
                out.write(bytes)
                file.finishWrite(out)
            } catch (e: Exception) {
                file.failWrite(out)
                throw e
            }
        } catch (e: Exception) {
            Log.w(TAG, "Last session not saved: ${e.javaClass.simpleName}")
        }
    }

    private companion object {
        const val TAG = "CyberJukeSession"
        const val KEY_POSITION = "position"
        const val CLOSE_WAIT_MS = 500L
    }
}
