package io.github.iamandelib.cyberjuke.playback

import androidx.media3.datasource.DataSpec
import io.github.iamandelib.cyberjuke.net.FailureKind
import java.util.TreeSet

/**
 * The listening cache's keys (AudioCache): `yt:<ytId>:<itag>:<clen>`, one per video, format
 * and file, instead of the stream URL, which expires and changes with every extraction. The
 * file's length (`clen` in the stream URL) is part of it, so another file under the same format
 * (a re-encode, a dubbed track) never mixes with the bytes of the first; `yt:<ytId>:<itag>`
 * when the URL doesn't say. Pure (CachePolicyTest).
 */
internal object CacheKeys {
    private const val PREFIX = "yt:"

    /** A copy at least this good counts as top quality when nothing else says what the top rung is. */
    const val TOP_CLASS_BPS = 128_000

    /** A cached copy this close to the bitrate asked for will do. */
    private const val CLOSE_ENOUGH = 0.9

    /**
     * YouTube's audio-only formats and their nominal bitrates (fixed per itag), so a cached
     * copy's quality is known without an extraction. AAC: 599, 139, 140, 141; Opus: 600, 249,
     * 250, 251, 774.
     */
    private val NOMINAL_BPS = mapOf(
        599 to 31_000, 139 to 48_000, 140 to 128_000, 141 to 256_000,
        600 to 35_000, 249 to 50_000, 250 to 70_000, 251 to 160_000, 774 to 256_000,
    )

    fun of(ytId: String, itag: Int, clen: Long? = null): String =
        if (clen != null && clen > 0) "$PREFIX$ytId:$itag:$clen" else "$PREFIX$ytId:$itag"

    /** A YouTube audio key: only these go through the cache (the CI tone and HLS don't). */
    fun isYt(key: String?): Boolean = key != null && parse(key) != null

    fun ytIdOf(key: String): String? = parse(key)?.first

    fun itagOf(key: String): Int? = parse(key)?.second

    private fun parse(key: String): Pair<String, Int>? {
        if (!key.startsWith(PREFIX)) return null
        val parts = key.substring(PREFIX.length).split(':')
        if (parts.size !in 2..3 || parts[0].isEmpty()) return null
        val itag = parts[1].toIntOrNull()?.takeIf { it > 0 } ?: return null
        if (parts.size == 3 && (parts[2].toLongOrNull() ?: 0L) <= 0L) return null
        return parts[0] to itag
    }

    /** The nominal bitrate of an audio-only itag, or null when it isn't one we know. */
    fun nominalBps(itag: Int): Int? = NOMINAL_BPS[itag]

    /**
     * The bitrate a cached copy must reach to stand in for a request ([pick]): offline, or for
     * Low, anything (0); otherwise the rung asked for: its format's when the link is known
     * ([rungItag]), else the video's ladder's ([ladderBps]), else for the top rung a top-class
     * copy ([TOP_CLASS_BPS]) and for a lower one anything.
     */
    fun wantedBps(quality: AudioQuality, autoRung: Int, rungItag: Int?, ladderBps: List<Int>, online: Boolean): Int {
        if (!online || quality == AudioQuality.LOW) return 0
        rungItag?.let { nominalBps(it) }?.let { return it }
        val rung = QualityLadder.rungFor(quality, autoRung)
        if (ladderBps.isNotEmpty()) return ladderBps[QualityLadder.index(ladderBps.size, rung)]
        return if (rung == 0) TOP_CLASS_BPS else 0
    }

    /**
     * A `yt:` load's flags on its way into the cache: without FLAG_DONT_CACHE_IF_LENGTH_UNKNOWN.
     * ExoPlayer sets it on every progressive load, to keep a live stream out of a cache, and
     * CacheDataSink then writes nothing when the response has no Content-Length (googlevideo's
     * answer to a POST may have none). A YouTube audio file is never live: it is cached anyway,
     * and the cache stores its length when the read reaches its end.
     */
    fun cacheFlags(flags: Int): Int = flags and DataSpec.FLAG_DONT_CACHE_IF_LENGTH_UNKNOWN.inv()

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
     * - else any whole one at least as good as [wantedBps] ([wantedBps]: online, a lower copy
     *   doesn't stand in for the quality asked; 0 = any).
     */
    fun pick(whole: List<Int>, keep: Int?, rungItag: Int?, wantedBps: Int = 0): Int? {
        if (keep != null) return keep.takeIf { it in whole }
        if (rungItag != null && rungItag in whole) return rungItag
        if (wantedBps <= 0) return whole.firstOrNull()
        return whole.firstOrNull { itag -> nominalBps(itag)?.let { it >= wantedBps * CLOSE_ENOUGH } == true }
    }

    /**
     * The key to play, of the [whole] ones (most recently used first): a resume only in the very
     * file it was playing ([keepKey]: its format and its length), never another file of the same
     * format; otherwise by format, as [pick] decides.
     */
    fun pickKey(whole: List<String>, keepKey: String?, rungItag: Int?, wantedBps: Int): String? {
        if (keepKey != null) return keepKey.takeIf { it in whole }
        val itag = pick(whole.mapNotNull { itagOf(it) }, null, rungItag, wantedBps) ?: return null
        return whole.firstOrNull { itagOf(it) == itag }
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
     * Returns the ones liked just now: those new since the last call when there are at most
     * [MAX_FRESH] (a few hearts tapped); none on the first call ([known] false, nothing to compare
     * with) or after a bigger change (a sign-in bringing likes back): those are the backfill's.
     */
    fun setLiked(ytIds: List<String>, known: Boolean = true): List<String> {
        val before = rank
        val next = HashMap<String, Int>(ytIds.size * 2)
        ytIds.forEachIndexed { i, id -> next.putIfAbsent(id, i) }
        val added = if (known) ytIds.filter { it !in before }.distinct() else emptyList()
        val fresh = if (added.size <= MAX_FRESH) added else emptyList()
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

    companion object {
        /** More new likes than this at once are not "liked just now" ([setLiked]). */
        const val MAX_FRESH = 3
    }
}

/**
 * Whether playback needs the network now, so the liked saver must wait or give way. The
 * player's isLoading alone says too much: a track after next waiting at the OpenGate keeps it
 * true almost all the time, also while paused. What counts: a stall; or, while it loads, the
 * playing track or the next one not all buffered yet. Not loading (the buffer is full to its cap,
 * a load failed), nothing prepared (a restored session before Play) or the list ended: nothing
 * needed. Pure (CachePolicyTest).
 */
internal object PlaybackNeed {
    /** Buffered to within this of the end counts as all there. */
    const val SLACK_MS = 1_000L

    data class Load(
        /** STATE_IDLE or STATE_ENDED. */
        val idle: Boolean,
        val buffering: Boolean,
        val positionMs: Long,
        /** The playing track's length; <= 0 while unknown. */
        val durationMs: Long,
        /** How far the playing track is buffered. */
        val bufferedPositionMs: Long,
        /** Everything buffered ahead of the position, across tracks. */
        val totalBufferedMs: Long,
        val hasNext: Boolean,
        /** The next track's length; <= 0 while unknown (not prepared yet). */
        val nextDurationMs: Long,
        /**
         * The player's isLoading. True doesn't mean playback needs the network (a gated load keeps
         * it true); false means it isn't using it.
         */
        val isLoading: Boolean = true,
    )

    fun needsNetwork(l: Load): Boolean {
        if (l.idle) return false
        if (l.buffering) return true
        // The current track just finished loading and the next isn't prepared yet: isLoading
        // drops for a moment before the next load starts, and a save begun now would compete
        // with it.
        if (l.hasNext && l.nextDurationMs <= 0 && l.durationMs > 0 && l.bufferedPositionMs >= l.durationMs - SLACK_MS) return true
        // Not loading (the buffer's size cap, or a load error on the next track): nothing comes
        // over the network until it loads again, and a save can't slow it down.
        if (!l.isLoading) return false
        if (l.durationMs <= 0) return true
        if (l.bufferedPositionMs < l.durationMs - SLACK_MS) return true
        if (!l.hasNext) return false
        if (l.nextDurationMs <= 0) return true
        val nextBuffered = l.totalBufferedMs - (l.durationMs - l.positionMs).coerceAtLeast(0L)
        return nextBuffered < l.nextDurationMs - SLACK_MS
    }
}

/**
 * What a save that failed to resolve its song means for that song: [GIVE_UP] (the video itself:
 * unavailable), [STRIKE] (the connection: counts toward [SaveStrikes]), [WAIT] (YouTube backing
 * off, or the extractor broken for every video: no fault of the song, no strike). Pure.
 */
internal enum class SaveFailure {
    GIVE_UP,
    STRIKE,
    WAIT,
    ;

    companion object {
        fun of(kind: FailureKind): SaveFailure = when {
            kind.blockReason != null || kind == FailureKind.BROKEN -> WAIT
            kind == FailureKind.NETWORK -> STRIKE
            else -> GIVE_UP
        }
    }
}

/** Saves that stopped (not cancelled) per song: the third time it is given up on for the service's life. */
internal class SaveStrikes {
    private val counts = HashMap<String, Int>()

    /** Counts a stop; true when [ytId] is to be given up on now. */
    fun stopped(ytId: String): Boolean {
        val n = (counts[ytId] ?: 0) + 1
        counts[ytId] = n
        return n >= MAX
    }

    companion object {
        const val MAX = 3
    }
}

/**
 * Videos whose cached copy turned out to be missing when read (evicted, or its file gone): for
 * [SKIP_MS] they are not served from the cache, so the load's retry goes to the network instead
 * of to the same miss. Thread-safe. Pure (CachePolicyTest).
 */
internal class CacheMisses(private val clock: () -> Long = { System.currentTimeMillis() }) {
    private val lru = TtlLru<String, Boolean>(64)

    fun missed(ytId: String) = lru.put(ytId, true, clock() + SKIP_MS)

    fun recent(ytId: String): Boolean = lru.get(ytId, clock()) == true

    companion object {
        const val SKIP_MS = 60_000L
    }
}

/**
 * Members-only audio in the cache, so signing out removes it all, whatever put it there:
 * - [mark]: a video known to be members-only (a queue item marked so, a members-only like);
 * - [onCached]: it reached the cache, so it is tagged (AudioCache keeps the tags in a file);
 * - [signOut]: every tagged or known one is to go, and while signed out none of them may come
 *   back in ([denied]: the cache is bypassed for them, and a span that slips in is removed);
 * - [signIn] lifts that.
 * Thread-safe. Pure (CachePolicyTest).
 */
internal class MembersAudio {
    private val known = HashSet<String>()
    private val tags = HashSet<String>()
    private val deny = HashSet<String>()
    private var signedOut = false

    @Synchronized
    fun mark(ytId: String) {
        known.add(ytId)
        if (signedOut) deny.add(ytId)
    }

    /** The tags kept from an earlier run. */
    @Synchronized
    fun load(ytIds: Collection<String>) {
        tags.addAll(ytIds)
    }

    /** [ytId]'s audio reached the cache; true when that's a new tag (to be written down). */
    @Synchronized
    fun onCached(ytId: String): Boolean = !signedOut && ytId in known && tags.add(ytId)

    @Synchronized
    fun tagged(): Set<String> = HashSet(tags)

    @Synchronized
    fun denied(ytId: String): Boolean = signedOut && ytId in deny

    /** Signed out: the videos whose audio is to go now; the tags are cleared. */
    @Synchronized
    fun signOut(): Set<String> {
        signedOut = true
        val gone = HashSet(tags).apply { addAll(known) }
        deny.addAll(gone)
        tags.clear()
        return gone
    }

    @Synchronized
    fun signIn() {
        signedOut = false
        deny.clear()
    }
}

/**
 * When the LikedSaver saves a liked song into the cache, and which. Pure (CachePolicyTest).
 *
 * - One at a time, newest like first; never one the player is loading anyway (the playing
 *   track and the next) nor one that failed this session.
 * - A song liked just now ([Facts.fresh]) is saved on any network, at once; if that try fails,
 *   again after [MIN_GAP_MS] like any other.
 * - Older likes (the backfill) only on an unmetered network (Wi-Fi), at most one extraction per
 *   [MIN_GAP_MS], and only while the cache has room for liked songs ([Facts.likedFull]).
 * - Never while offline, during a YouTube back-off ([Facts.quiet]) or while playback needs the
 *   network ([PlaybackNeed]): playback always comes first (a running save gives way, [keepGoing]).
 *
 * Event-driven: asked again when something it depends on changes. The one timer is
 * [recheckInMs]: a one-shot re-check at the end of the gap, pending only while the gap alone
 * holds back a save that could start.
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
        /** Liked just now this session. */
        val fresh: Set<String> = emptySet(),
        /** Of those, the ones already tried once (their retries wait for the gap). */
        val tried: Set<String> = emptySet(),
        /** Not to be saved now: the playing and next tracks, and failures this session. */
        val skip: Set<String> = emptySet(),
        val online: Boolean = true,
        val unmetered: Boolean = true,
        val quiet: Boolean = false,
        val playbackNeedsNetwork: Boolean = false,
        val busy: Boolean = false,
        val likedFull: Boolean = false,
        /** Since the last saver extraction; Long.MAX_VALUE when none yet. */
        val sinceLastMs: Long = Long.MAX_VALUE,
        /** Members-only while signed out: never saved. Asked only of a candidate. */
        val denied: (String) -> Boolean = { false },
    )

    /** The video to save now, or null. */
    fun next(f: Facts): String? = pick(f, f.sinceLastMs)

    private fun pick(f: Facts, sinceLastMs: Long): String? {
        if (f.busy || !f.online || f.quiet || f.playbackNeedsNetwork) return null
        // Each candidate's denied answer is asked once (and only for those looked at).
        val denied = HashMap<String, Boolean>()
        val todo = f.liked.asSequence().filter { it !in f.saved && it !in f.skip && !denied.getOrPut(it) { f.denied(it) } }
        todo.firstOrNull { it in f.fresh && it !in f.tried }?.let { return it }
        if (sinceLastMs < MIN_GAP_MS) return null
        todo.firstOrNull { it in f.fresh }?.let { return it }
        if (!f.unmetered || f.likedFull) return null
        return todo.firstOrNull()
    }

    /**
     * When to ask again, if only the gap holds back a save that could start: then (the one
     * postDelayed, while that work waits); otherwise null (an event will come).
     */
    fun recheckInMs(f: Facts): Long? {
        if (f.sinceLastMs >= MIN_GAP_MS || pick(f, f.sinceLastMs) != null) return null
        return if (pick(f, Long.MAX_VALUE) != null) MIN_GAP_MS - f.sinceLastMs else null
    }

    /** Whether a save of a [fresh] (or backfill) like may go on, or must stop and give way. */
    fun keepGoing(f: Facts, fresh: Boolean): Boolean =
        f.online && !f.quiet && !f.playbackNeedsNetwork && (fresh || f.unmetered)
}
