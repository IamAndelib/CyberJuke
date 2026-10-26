package io.github.iamandelib.cyberjuke.playback

import androidx.media3.datasource.DataSpec
import io.github.iamandelib.cyberjuke.net.FailureKind
import java.util.TreeSet

/**
 * Which file a load must keep (StreamResolver): a resume keeps the file it was playing, and so
 * does a track kept through an outage ([StreamResolver.keepFormat]). Pure (FormatKeepTest).
 */
internal object FormatKeep {
    /** The itag a stream link must be of: a [kept] format's, else for a resume the one served; null: any rung. */
    fun itag(kept: Int?, midStream: Boolean, servedItag: Int?): Int? =
        kept ?: if (midStream) servedItag?.takeIf { it > 0 } else null

    /** Only one saved copy will do: the file that was playing ([kept] format, or a resume). */
    fun mustKeep(kept: Boolean, midStream: Boolean): Boolean = kept || midStream
}

/**
 * The listening cache's keys (AudioCache): `yt:<ytId>:<itag>:<clen>`, one per video, format
 * and file, instead of the stream URL, which expires and changes with every extraction. The
 * file's length (`clen` in the stream URL) is part of it, so another file under the same format
 * (a re-encode, a dubbed track) never mixes with the bytes of the first; `yt:<ytId>:<itag>`
 * when the URL doesn't say. A Jukebox MP3's key is its audio id, `mp3:<file>` ([ofMp3]): one
 * fixed file per post on latex.gg, with no format or length to tell apart. Every key names the
 * audio id it keeps ([audioIdOf]), the 11-character video id or the MP3's, which never meet.
 * Pure (CachePolicyTest).
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

    /** A YouTube audio key. */
    fun isYt(key: String?): Boolean = key != null && parse(key) != null

    fun ytIdOf(key: String): String? = parse(key)?.first

    /** A Jukebox MP3's key ([SessionPolicy.mp3AudioId] of its file name), or null for anything else. */
    fun ofMp3(file: String?): String? = SessionPolicy.mp3AudioId(file)

    /** A Jukebox MP3's key. */
    fun isMp3(key: String?): Boolean = SessionPolicy.mp3FileOfAudioId(key) != null

    /** A key that goes through the cache: YouTube audio or a Jukebox MP3 (the CI tone and HLS don't). */
    fun isCacheable(key: String?): Boolean = isYt(key) || isMp3(key)

    /** The audio id [key] keeps: the video id of a `yt:` key, an MP3's key itself; null for anything else. */
    fun audioIdOf(key: String): String? = ytIdOf(key) ?: key.takeIf { isMp3(it) }

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
     * The bitrate a cached copy must reach to stand in for a request ([pick]). Only High asks for
     * one; Auto, Low and offline take any whole copy (0): a song already on the phone is played
     * from it whatever the quality setting, as InnerTune and Metrolist do, rather than downloaded
     * again for a notch more (a fresh process has no ladder in memory, so Auto's rung would ask
     * for the top one and skip a copy saved at Low). High wants its format's bitrate when the
     * link is known ([rungItag]), else the video's ladder's top ([ladderBps]), else a top-class
     * copy ([TOP_CLASS_BPS]).
     */
    fun wantedBps(quality: AudioQuality, rungItag: Int?, ladderBps: List<Int>, online: Boolean): Int {
        if (!online || quality != AudioQuality.HIGH) return 0
        rungItag?.let { nominalBps(it) }?.let { return it }
        return ladderBps.firstOrNull() ?: TOP_CLASS_BPS
    }

    /**
     * A cached load's flags on its way into the cache: without FLAG_DONT_CACHE_IF_LENGTH_UNKNOWN.
     * ExoPlayer sets it on every progressive load, to keep a live stream out of a cache, and
     * CacheDataSink then writes nothing when the response has no Content-Length (googlevideo's
     * answer to a POST may have none). A YouTube audio file is never live, nor is a Jukebox MP3
     * (an uploaded file): each is cached anyway, and the cache stores its length when the read
     * reaches its end. (Whether latex.gg sends a Content-Length and honours Range requests, which
     * a partly cached MP3 needs for the rest, is not verified from here; without Range support
     * the rest is read from the start of the file again, as any HTTP source does.)
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
     * - else any whole one at least as good as [wantedBps] (the most recently used first;
     *   [wantedBps]: on High online, a lower copy doesn't stand in for the quality asked; 0 = any,
     *   which is what Auto, Low and offline ask).
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

    /**
     * The key to play of [audioId]'s [whole] copies: a Jukebox MP3 has one file and no formats,
     * so its whole copy plays whatever the quality setting or a resume asks; a video's is
     * [pickKey]'s choice.
     */
    fun pickFor(audioId: String, whole: List<String>, keepKey: String?, rungItag: Int?, wantedBps: Int): String? =
        if (isMp3(audioId)) whole.firstOrNull() else pickKey(whole, keepKey, rungItag, wantedBps)
}

/**
 * The bookkeeping behind JukeCacheEvictor: what the cache holds per key (the sum of its spans,
 * when it was last used), and which audio ids (videos and Jukebox MP3s) are liked, in order. The cache has a size limit
 * (changeable); over it, whole keys go:
 * 1. listening entries (not liked), least recently used first;
 * 2. liked entries only when liked songs alone are over the limit, least recently liked first.
 *
 * Kept up to date incrementally from the cache's span callbacks (no scans); only a change of the
 * liked list sorts the entries again. Not thread-safe: AudioCache calls it under the cache's
 * lock. Pure (CachePolicyTest).
 */
internal class CacheLedger(limitBytes: Long) {
    private class Entry(val key: String, val audioId: String) {
        var bytes = 0L
        var touched = 0L

        /** Position in the liked list (0 = the newest like), or -1: a listening entry. */
        var likedRank = -1
    }

    private val entries = HashMap<String, Entry>()
    private val keysByAudio = HashMap<String, MutableSet<String>>()

    /** Listening entries, least recently used first. */
    private val listening = TreeSet<Entry>(compareBy<Entry>({ it.touched }, { it.key }))

    /** Liked entries, least recently liked first. */
    private val likedEntries = TreeSet<Entry>(compareBy<Entry>({ -it.likedRank }, { it.key }))

    private var rank: Map<String, Int> = emptyMap()

    /** The liked audio ids, newest like first. */
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
        val audioId = CacheKeys.audioIdOf(key) ?: key
        val e = entries[key] ?: Entry(key, audioId).also {
            it.likedRank = rank[audioId] ?: -1
            entries[key] = it
            keysByAudio.getOrPut(audioId) { HashSet(2) }.add(key)
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
        keysByAudio[e.audioId]?.let { keys ->
            keys.remove(key)
            if (keys.isEmpty()) keysByAudio.remove(e.audioId)
        }
    }

    /**
     * Forgets every span, keeping the liked list and the limit: a start that failed had counted
     * the spans on disk before failing, and a cache that isn't there has nothing to evict or play.
     */
    fun resetSpans() {
        entries.clear()
        keysByAudio.clear()
        listening.clear()
        likedEntries.clear()
        total = 0L
        likedBytes = 0L
    }

    fun onTouched(key: String, touched: Long) {
        val e = entries[key] ?: return
        if (touched <= e.touched) return
        unlist(e)
        e.touched = touched
        relist(e)
    }

    /**
     * The liked audio ids, newest like first (unliking makes one an ordinary listening entry).
     * Returns the ones liked just now: those new since the last call when there are at most
     * [MAX_FRESH] (a few hearts tapped); none on the first call ([known] false, nothing to compare
     * with) or after a bigger change (a sign-in bringing likes back): those are the backfill's.
     */
    fun setLiked(ids: List<String>, known: Boolean = true): List<String> {
        val before = rank
        val next = HashMap<String, Int>(ids.size * 2)
        ids.forEachIndexed { i, id -> next.putIfAbsent(id, i) }
        val added = if (known) ids.filter { it !in before }.distinct() else emptyList()
        val fresh = if (added.size <= MAX_FRESH) added else emptyList()
        rank = next
        liked = ids.distinct()
        listening.clear()
        likedEntries.clear()
        likedBytes = 0L
        for (e in entries.values) {
            e.likedRank = next[e.audioId] ?: -1
            if (e.likedRank >= 0) likedBytes += e.bytes
            relist(e)
        }
        return fresh
    }

    fun isLiked(audioId: String): Boolean = audioId in rank

    /** The keys of [audioId]'s cached formats, most recently used first. */
    fun keysOf(audioId: String): List<String> =
        keysByAudio[audioId]?.mapNotNull { entries[it] }?.sortedByDescending { it.touched }?.map { it.key } ?: emptyList()

    /** The cached bytes of [key] (0 when none). Tests only. */
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

    /**
     * Which of the playing track ([current]) and the next ([next]) the player is still loading,
     * so the liked saver leaves them to it: one not all buffered yet (or of unknown length),
     * unless the player is idle or ended. One all buffered is done: the saver may repair it in
     * the cache (only the bytes missing there are fetched).
     */
    fun stillLoading(l: Load, current: String?, next: String?): Set<String> {
        if (l.idle) return emptySet()
        val out = HashSet<String>(2)
        val currentLoading = l.durationMs <= 0 || l.bufferedPositionMs < l.durationMs - SLACK_MS
        if (current != null && currentLoading) out.add(current)
        if (next != null && l.hasNext) {
            val nextBuffered = l.totalBufferedMs - (l.durationMs - l.positionMs).coerceAtLeast(0L)
            if (currentLoading || l.nextDurationMs <= 0 || nextBuffered < l.nextDurationMs - SLACK_MS) out.add(next)
        }
        return out
    }

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

/**
 * Whether a liked save's writer was refused for good (not again this service's life), from the
 * HTTP status it got ([httpCode], null for none). A video's link refused at all: expired or a
 * block. A Jukebox MP3 ([mp3]) only on a 4xx that says the file is gone or private, as playback
 * never retries one ([JukeLoadErrorPolicy]). latex.gg failing (a 5xx), timing out (408), rate
 * limiting (429) or refusing a range (416, from a length it never sent) is a strike instead,
 * tried again later and given up on after [SaveStrikes.MAX]. Pure (CachePolicyTest).
 */
internal object SaveRefusal {
    private val TRANSIENT_4XX = setOf(408, 416, 429)

    fun refused(httpCode: Int?, mp3: Boolean): Boolean =
        httpCode != null && (!mp3 || (httpCode in 400..499 && httpCode !in TRANSIENT_4XX))
}

/**
 * Saves that stopped (not cancelled) per song, and when each may be tried again: after the n-th
 * stop the song waits [FIRST_WAIT_MS] doubled each time (30 s, 1, 2, 4 min), the [MAX]th stop
 * gives up on it for the service's life. Media3's DownloadManager retries a download five times
 * (DEFAULT_MIN_RETRY_COUNT) before it fails; the doubling is [LoadRetry.delayMs]'s shape, drawn
 * out, since a save is never urgent. Main thread; pure (CachePolicyTest).
 */
internal class SaveStrikes {
    private val counts = HashMap<String, Int>()

    /** When each waiting song's retry is due; only entries not yet due are kept. */
    private val dueAt = HashMap<String, Long>()

    /** Counts a stop at [now]; true when [ytId] is to be given up on now, else it waits its turn. */
    fun stopped(ytId: String, now: Long): Boolean {
        val n = (counts[ytId] ?: 0) + 1
        counts[ytId] = n
        if (n >= MAX) {
            dueAt.remove(ytId)
            return true
        }
        dueAt[ytId] = now + waitMs(n)
        return false
    }

    /** [ytId] was saved after all: its stops are forgotten, so a later trouble starts afresh. */
    fun forget(ytId: String) {
        counts.remove(ytId)
        dueAt.remove(ytId)
    }

    /** The songs waiting for their retry at [now] (not to be saved yet). */
    fun waiting(now: Long): Set<String> {
        dueAt.values.removeAll { it <= now }
        return HashSet(dueAt.keys)
    }

    /** Until the earliest retry is due, from [now]; null when none waits. */
    fun nextDueInMs(now: Long): Long? = dueAt.values.minOrNull()?.let { it - now }?.takeIf { it > 0 }

    companion object {
        /** Stops before a song is given up on. */
        const val MAX = 5

        const val FIRST_WAIT_MS = 30_000L

        /** 30 s, 1, 2, 4 min after the [stops]th stop (from 1). */
        fun waitMs(stops: Int): Long = FIRST_WAIT_MS shl (stops - 1).coerceIn(0, MAX - 2)
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
 * Members-only audio in the cache, so signing out removes it all, whatever put it there. By
 * audio id ([SessionPolicy.isValidAudioId]): a members-only Jukebox MP3 goes like a video.
 * - [mark]: a video known to be members-only (a queue item marked so, a members-only like);
 * - [onCached]: it reached the cache, so it is tagged (AudioCache keeps the tags in a file);
 * - [signOut]: every tagged or known one is to go, and while signed out none of them may come
 *   back in ([denied]: the cache is bypassed for them, and a span that slips in is removed);
 *   their tags stay until [removed] says the audio went (a cache that didn't start removes
 *   nothing: the tags wait for the next start);
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

    /** The videos marked members-only in this run. */
    @Synchronized
    fun marked(): Set<String> = HashSet(known)

    /** What [reconcile] found: the videos whose audio is to go, and whether a tag is new. */
    data class Reconciled(val remove: List<String>, val tagged: Boolean)

    /**
     * Brings the audio of members-only videos already in the cache ([inCache]) in line: signed
     * out, it is to go ([Reconciled.remove]); signed in, it is tagged ([Reconciled.tagged]: a new
     * tag, to be written down). For marks that come after the audio was counted in (the cache
     * was starting then, or the audio was already there).
     */
    @Synchronized
    fun reconcile(inCache: Collection<String>): Reconciled {
        val remove = ArrayList<String>()
        var tagged = false
        for (id in inCache) {
            if (denied(id)) remove.add(id) else tagged = onCached(id) || tagged
        }
        return Reconciled(remove, tagged)
    }

    @Synchronized
    fun denied(ytId: String): Boolean = signedOut && ytId in deny

    /** Signed out: the videos whose audio is to go now. */
    @Synchronized
    fun signOut(): Set<String> {
        signedOut = true
        val gone = HashSet(tags).apply { addAll(known) }
        deny.addAll(gone)
        return gone
    }

    /** The audio of [ytIds] is out of the cache: their tags go. */
    @Synchronized
    fun removed(ytIds: Collection<String>) {
        tags.removeAll(ytIds.toSet())
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
 * - One at a time, newest like first; never one the player is still loading anyway (the
 *   playing track or the next, [PlaybackNeed.stillLoading]), one that failed this session, nor
 *   one waiting for its retry after a stop ([SaveStrikes]).
 * - A song liked just now ([Facts.fresh]) is saved on any network, at once; if that try fails,
 *   again after [MIN_GAP_MS] like any other.
 * - Older likes (the backfill) only on an unmetered network (Wi-Fi), at most one extraction per
 *   [MIN_GAP_MS], and only while the cache has room for liked songs ([Facts.likedFull]).
 * - Never while offline, or while playback needs the network ([PlaybackNeed]): playback always
 *   comes first (a running save gives way, [keepGoing]). During a YouTube back-off
 *   ([Facts.quiet]) only Jukebox MP3s (audio ids `mp3:<file>`): no extraction, not YouTube's.
 * - Never without a cache to save into ([Facts.cache]): no extraction for nothing.
 *
 * Event-driven: asked again when something it depends on changes. The one timer is
 * [recheckInMs]: a one-shot re-check for the end of the gap, pending only while the gap alone
 * holds back a save that could start, or for the earliest retry due after a stop (its wait ending
 * is the event, and no other may come), whichever is sooner.
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
        /**
         * Not to be saved now: the playing and next tracks while still loading, failures this
         * session, and songs waiting for their retry after a stop ([SaveStrikes.waiting]).
         */
        val skip: Set<String> = emptySet(),
        val online: Boolean = true,
        val unmetered: Boolean = true,
        /** A YouTube back-off: no video is saved (no extraction); a Jukebox MP3 still is. */
        val quiet: Boolean = false,
        val playbackNeedsNetwork: Boolean = false,
        val busy: Boolean = false,
        val likedFull: Boolean = false,
        /** Since the last saver extraction; Long.MAX_VALUE when none yet. */
        val sinceLastMs: Long = Long.MAX_VALUE,
        /** Until the earliest retry after a stop is due ([SaveStrikes.nextDueInMs]); null when none waits. */
        val retryInMs: Long? = null,
        /** Members-only while signed out: never saved. Asked only of a candidate. */
        val denied: (String) -> Boolean = { false },
        /** There is a cache to save into (none after it failed to start: [AudioCache.startFailed]). */
        val cache: Boolean = true,
    )

    /**
     * After Clear cache: the liked songs of the player's [pair] (playing and next) count as
     * liked just now. Their bytes are in the player's memory, so nothing writes them back;
     * saved like a new like, on any network, once the player has loaded them.
     */
    fun freshAfterClear(liked: Collection<String>, pair: Set<String>): Set<String> = pair.filterTo(HashSet()) { it in liked }

    /** The video to save now, or null. */
    fun next(f: Facts): String? = pick(f, f.sinceLastMs)

    private fun pick(f: Facts, sinceLastMs: Long): String? {
        if (!f.cache || f.busy || !f.online || f.playbackNeedsNetwork) return null
        // Each candidate's denied answer is asked once (and only for those looked at).
        val denied = HashMap<String, Boolean>()
        val todo = f.liked.asSequence().filter {
            it !in f.saved && it !in f.skip && (!f.quiet || CacheKeys.isMp3(it)) && !denied.getOrPut(it) { f.denied(it) }
        }
        todo.firstOrNull { it in f.fresh && it !in f.tried }?.let { return it }
        if (sinceLastMs < MIN_GAP_MS) return null
        todo.firstOrNull { it in f.fresh }?.let { return it }
        if (!f.unmetered || f.likedFull) return null
        return todo.firstOrNull()
    }

    /**
     * When to ask again (the one postDelayed): at the end of the gap, if only the gap holds back
     * a save that could start; or when the earliest retry after a stop is due ([Facts.retryInMs]);
     * whichever is sooner. Null when a save starts now (it asks again when it finishes) or when
     * neither waits (an event will come).
     */
    fun recheckInMs(f: Facts): Long? {
        if (!f.cache || pick(f, f.sinceLastMs) != null) return null
        val gap = if (f.sinceLastMs < MIN_GAP_MS && pick(f, Long.MAX_VALUE) != null) MIN_GAP_MS - f.sinceLastMs else null
        return listOfNotNull(gap, f.retryInMs).minOrNull()
    }

    /** Whether a save of a [fresh] (or backfill) like, a Jukebox MP3's if [mp3], may go on, or must stop and give way. */
    fun keepGoing(f: Facts, fresh: Boolean, mp3: Boolean = false): Boolean =
        f.cache && f.online && (mp3 || !f.quiet) && !f.playbackNeedsNetwork && (fresh || f.unmetered)
}

/**
 * How a liked save ended: [SAVED] (whole in the cache), [FAILED] (not this service's life),
 * [STOPPED] (a strike: tried again later, [SaveStrikes]), [CANCELLED] (no fault of the song). Pure.
 */
internal enum class SaveOutcome {
    SAVED,
    FAILED,
    STOPPED,
    CANCELLED,
    ;

    companion object {
        /**
         * The writer got to the end: saved only if the song is now whole in the cache. A span
         * playback was writing at the same time is read past, not written (its lock), and a
         * length never learned leaves it not whole: a strike then, and it is tried again later.
         */
        fun afterWrite(whole: Boolean): SaveOutcome = if (whole) SAVED else STOPPED
    }
}
