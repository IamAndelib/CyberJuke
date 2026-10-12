package io.github.iamandelib.cyberjuke.playback

import java.util.TreeSet

/**
 * The listening cache's keys (AudioCache): `yt:<ytId>:<itag>`, one per video and format,
 * instead of the stream URL, which expires and changes with every extraction. Pure
 * (CachePolicyTest).
 */
internal object CacheKeys {
    private const val PREFIX = "yt:"

    fun of(ytId: String, itag: Int): String = "$PREFIX$ytId:$itag"

    /** A YouTube audio key: only these go through the cache (the CI tone and HLS don't). */
    fun isYt(key: String?): Boolean = key != null && parse(key) != null

    fun ytIdOf(key: String): String? = parse(key)?.first

    fun itagOf(key: String): Int? = parse(key)?.second

    private fun parse(key: String): Pair<String, Int>? {
        if (!key.startsWith(PREFIX)) return null
        val rest = key.substring(PREFIX.length)
        val colon = rest.lastIndexOf(':')
        if (colon <= 0) return null
        val itag = rest.substring(colon + 1).toIntOrNull()?.takeIf { it > 0 } ?: return null
        return rest.substring(0, colon) to itag
    }

    /**
     * Whether a resource is in the cache whole: its length is known ([contentLength], -1 when
     * not) and [isCached] says every byte from 0 to it is there.
     */
    fun isWhole(contentLength: Long, isCached: (Long) -> Boolean): Boolean = contentLength > 0 && isCached(contentLength)

    /**
     * Which whole copy of a video to play from the cache, of the formats in [whole] (most
     * recently used first), or null to load it as usual:
     * - [keep], the format a resume or a track kept through an outage must stay in: that one
     *   or none (another file mid-song would be garbage);
     * - else [rungItag], the format the quality setting asks for, when known and whole;
     * - else any whole one: better than a request.
     */
    fun pick(whole: List<Int>, keep: Int?, rungItag: Int?): Int? = when {
        keep != null -> keep.takeIf { it in whole }
        rungItag != null && rungItag in whole -> rungItag
        else -> whole.firstOrNull()
    }
}

/**
 * The bookkeeping behind JukeCacheEvictor: what the cache holds per key (the sum of its spans,
 * when it was last used), and which videos are liked, in order. The cache has a size limit
 * (changeable); over it, whole keys go:
 * 1. listening entries (not liked), least recently used first;
 * 2. liked entries only when liked songs alone are over the limit, least recently liked first.
 *
 * Kept up to date incrementally from the cache's span callbacks (no scans); only a change of the
 * liked list sorts the entries again. Not thread-safe: AudioCache calls it under the cache's
 * lock. Pure (CachePolicyTest).
 */
internal class CacheLedger(limitBytes: Long) {
    private class Entry(val key: String, val ytId: String) {
        var bytes = 0L
        var touched = 0L

        /** Position in the liked list (0 = the newest like), or -1: a listening entry. */
        var likedRank = -1
    }

    private val entries = HashMap<String, Entry>()
    private val keysByYt = HashMap<String, MutableSet<String>>()

    /** Listening entries, least recently used first. */
    private val listening = TreeSet<Entry>(compareBy<Entry>({ it.touched }, { it.key }))

    /** Liked entries, least recently liked first. */
    private val likedEntries = TreeSet<Entry>(compareBy<Entry>({ -it.likedRank }, { it.key }))

    private var rank: Map<String, Int> = emptyMap()

    /** The liked videos, newest like first. */
    var liked: List<String> = emptyList()
        private set

    var limit: Long = limitBytes

    /** Bytes in the cache. */
    var total = 0L
        private set

    /** Bytes of liked songs in the cache. */
    var likedBytes = 0L
        private set

    fun onAdded(key: String, bytes: Long, touched: Long) {
        val ytId = CacheKeys.ytIdOf(key) ?: key
        val e = entries[key] ?: Entry(key, ytId).also {
            it.likedRank = rank[ytId] ?: -1
            entries[key] = it
            keysByYt.getOrPut(ytId) { HashSet(2) }.add(key)
        }
        unlist(e)
        e.bytes += bytes
        e.touched = maxOf(e.touched, touched)
        total += bytes
        if (e.likedRank >= 0) likedBytes += bytes
        relist(e)
    }

    fun onRemoved(key: String, bytes: Long) {
        val e = entries[key] ?: return
        unlist(e)
        e.bytes -= bytes
        total -= bytes
        if (e.likedRank >= 0) likedBytes -= bytes
        if (e.bytes > 0) {
            relist(e)
            return
        }
        entries.remove(key)
        keysByYt[e.ytId]?.let { keys ->
            keys.remove(key)
            if (keys.isEmpty()) keysByYt.remove(e.ytId)
        }
    }

    fun onTouched(key: String, touched: Long) {
        val e = entries[key] ?: return
        if (touched <= e.touched) return
        unlist(e)
        e.touched = touched
        relist(e)
    }

    /**
     * The liked videos, newest like first (unliking makes one an ordinary listening entry).
     * Returns the ones liked since the last call: none on the first call ([known] false), when
     * there is nothing to compare with.
     */
    fun setLiked(ytIds: List<String>, known: Boolean = true): List<String> {
        val before = rank
        val next = HashMap<String, Int>(ytIds.size * 2)
        ytIds.forEachIndexed { i, id -> next.putIfAbsent(id, i) }
        val fresh = if (known) ytIds.filter { it !in before }.distinct() else emptyList()
        rank = next
        liked = ytIds.distinct()
        listening.clear()
        likedEntries.clear()
        likedBytes = 0L
        for (e in entries.values) {
            e.likedRank = next[e.ytId] ?: -1
            if (e.likedRank >= 0) likedBytes += e.bytes
            relist(e)
        }
        return fresh
    }

    fun isLiked(ytId: String): Boolean = ytId in rank

    /** Forgets every entry (the cache is opened again and replays its spans); the liked list stays. */
    fun clearEntries() {
        entries.clear()
        keysByYt.clear()
        listening.clear()
        likedEntries.clear()
        total = 0L
        likedBytes = 0L
    }

    /** The keys of [ytId]'s cached formats, most recently used first. */
    fun keysOf(ytId: String): List<String> =
        keysByYt[ytId]?.mapNotNull { entries[it] }?.sortedByDescending { it.touched }?.map { it.key } ?: emptyList()

    /** The cached bytes of [key] (0 when none). */
    fun bytesOf(key: String): Long = entries[key]?.bytes ?: 0L

    /**
     * The keys to remove, in order, so that [extra] more bytes fit under the limit; never
     * [protect] (the key being written). Empty when it all fits.
     */
    fun victims(extra: Long = 0L, protect: String? = null): List<String> {
        var over = total + extra - limit
        if (over <= 0) return emptyList()
        val out = ArrayList<String>()
        for (set in listOf(listening, likedEntries)) {
            for (e in set) {
                if (e.key == protect) continue
                out.add(e.key)
                over -= e.bytes
                if (over <= 0) return out
            }
        }
        return out
    }

    /** Liked songs leave this much room under the limit before the backfill stops adding more. */
    fun likedFull(reserve: Long): Boolean = likedBytes + reserve > limit

    private fun unlist(e: Entry) {
        listening.remove(e)
        likedEntries.remove(e)
    }

    private fun relist(e: Entry) {
        if (e.likedRank >= 0) likedEntries.add(e) else listening.add(e)
    }
}

/**
 * When the LikedSaver saves a liked song into the cache, and which. Pure (CachePolicyTest).
 *
 * - One at a time, newest like first; never one the player is loading anyway (the playing
 *   track and the next) nor one that failed this session.
 * - A song liked just now ([Facts.fresh]) is saved on any network, at once.
 * - Older likes (the backfill) only on an unmetered network (Wi-Fi), at most one extraction per
 *   [MIN_GAP_MS], and only while the cache has room for liked songs ([Facts.likedFull]).
 * - Never while offline, during a YouTube back-off ([Facts.quiet]) or while the player is
 *   loading: playback always comes first (a running save gives way, [keepGoing]).
 *
 * Event-driven: asked again when something it depends on changes, never on a timer.
 */
internal object LikedSaverPolicy {
    /** At least this long between two backfill extractions (YouTube request volume). */
    const val MIN_GAP_MS = 30_000L

    /** Liked songs leave this much of the limit to listening (the playing and next tracks). */
    const val LISTENING_RESERVE_BYTES = 32L * 1024 * 1024

    data class Facts(
        /** Newest like first. */
        val liked: List<String>,
        /** Saved whole in the cache. */
        val saved: Set<String>,
        /** Liked this session. */
        val fresh: Set<String> = emptySet(),
        /** Not to be saved now: the playing and next tracks, and failures this session. */
        val skip: Set<String> = emptySet(),
        val online: Boolean = true,
        val unmetered: Boolean = true,
        val quiet: Boolean = false,
        val playerLoading: Boolean = false,
        val busy: Boolean = false,
        val likedFull: Boolean = false,
        /** Since the last saver extraction; Long.MAX_VALUE when none yet. */
        val sinceLastMs: Long = Long.MAX_VALUE,
    )

    /** The video to save now, or null. */
    fun next(f: Facts): String? {
        if (f.busy || !f.online || f.quiet || f.playerLoading) return null
        val todo = f.liked.asSequence().filter { it !in f.saved && it !in f.skip }
        todo.firstOrNull { it in f.fresh }?.let { return it }
        if (!f.unmetered || f.likedFull || f.sinceLastMs < MIN_GAP_MS) return null
        return todo.firstOrNull()
    }

    /** Whether a save of a [fresh] (or backfill) like may go on, or must stop and give way. */
    fun keepGoing(f: Facts, fresh: Boolean): Boolean =
        f.online && !f.quiet && !f.playerLoading && (fresh || f.unmetered)
}
