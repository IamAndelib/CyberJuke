package io.github.iamandelib.cyberjuke.playback

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import androidx.media3.datasource.cache.Cache
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheEvictor
import androidx.media3.datasource.cache.CacheSpan
import androidx.media3.datasource.cache.ContentMetadata
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.datasource.okhttp.OkHttpDataSource
import io.github.iamandelib.cyberjuke.net.Http
import java.io.File
import java.io.IOException
import java.util.concurrent.CopyOnWriteArraySet

/**
 * The listening cache: the audio of recently played and next tracks and of liked songs, on the
 * phone only (cacheDir/audio, which Android never backs up; its index is in the ExoPlayer
 * database, kept out of backups by the backup rules). Up to the size chosen in Settings
 * (128, 256 or 512 MB); over it, [CacheLedger]'s order decides what goes.
 *
 * - One [SimpleCache] for the process (it refuses a second one on the same folder), opened on
 *   first use off the main thread and kept open for the process's life: never released, so
 *   nothing blocks the main thread in onDestroy, and nothing is lost when the process dies
 *   (every span is indexed as it is written).
 * - Keys are `yt:<ytId>:<itag>:<clen>` ([CacheKeys]), set by [YtDataSpecResolver]; only those
 *   go through the cache ([CacheRouter]), so the CI tone and HLS are untouched.
 * - A track saved whole plays from it with no extraction and no request
 *   ([StreamResolver.cachedKey]).
 * - Which liked songs are saved whole is kept up to date from the span callbacks and sent to
 *   the page as `cacheChanged` (only when that set changes).
 * - Members-only audio is tagged as it comes in ([MembersAudio], the tags in a file beside the
 *   cache), so signing out ([signedOut]) removes all of it, and none comes back in until a
 *   sign-in.
 * - No googlevideo URL is kept: the upstream ([CacheMissGuard]) reports the URL it was asked
 *   for, so the cache never records a redirect.
 *
 * Threads: the ledger and the saved set are only touched under the cache's own lock (its span
 * callbacks hold it; everything else takes it). The main thread only reads the published
 * snapshots ([savedLiked], [liked], [likedFull]), never the cache itself. Nothing here runs on a
 * timer.
 */
@OptIn(UnstableApi::class)
internal object AudioCache {
    private const val TAG = "CyberJukeCache"
    private const val DIR = "audio"

    /** The liked list, newest first, beside the cache (also never backed up). */
    private const val LIKED_FILE = "audio-liked"

    /** The tags of members-only audio in the cache, beside it. */
    private const val MEMBERS_FILE = "audio-members"

    const val DEFAULT_MB = 256
    val SIZES_MB = listOf(128, 256, 512)
    private const val MB = 1024L * 1024L

    /** The liked songs saved whole changed ([savedLiked]), or the cache was cleared; any thread. */
    fun interface Listener {
        fun onSavedChanged()

        /** Clear cache emptied it. */
        fun onCleared() = Unit
    }

    /** The liked list changed; [fresh]: liked just now. Any thread. */
    fun interface LikedListener {
        fun onLikedChanged(fresh: List<String>)
    }

    private val listeners = CopyOnWriteArraySet<Listener>()
    private val likedListeners = CopyOnWriteArraySet<LikedListener>()

    fun addListener(l: Listener) = listeners.add(l)
    fun removeListener(l: Listener) = listeners.remove(l)
    fun addLikedListener(l: LikedListener) = likedListeners.add(l)
    fun removeLikedListener(l: LikedListener) = likedListeners.remove(l)

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var cache: SimpleCache? = null

    /** The limit in MB (Settings), kept to apply when the cache opens. */
    @Volatile
    private var limitMb = DEFAULT_MB

    /** Guarded by the open cache's lock (see the class comment). */
    private val ledger = CacheLedger(DEFAULT_MB * MB)

    /** Liked songs saved whole, guarded like [ledger]. */
    private val saved = HashSet<String>()

    /** The liked list came from the page or the file (until then no like is "fresh"). */
    private var likedKnown = false

    /** Members-only audio (thread-safe itself). */
    private val members = MembersAudio()

    /** Copies just found missing: not served from the cache for a moment ([CacheMissGuard]). */
    val misses = CacheMisses()

    /** The device has a validated network (PlaybackService): online, a lower copy doesn't stand in. */
    @Volatile
    var online: Boolean = true

    /** Stops the liked save in progress, if any (LikedSaver sets it while one runs). */
    @Volatile
    var cancelSave: (() -> Unit)? = null

    /** The liked songs saved whole (a snapshot; any thread). */
    @Volatile
    var savedLiked: Set<String> = emptySet()
        private set

    /** The liked videos, newest like first (a snapshot). */
    @Volatile
    var liked: List<String> = emptyList()
        private set

    /** Liked songs fill the cache: the backfill waits ([LikedSaverPolicy]). */
    @Volatile
    var likedFull: Boolean = false
        private set

    /** Cheap: remembers the context and the limit. The cache itself opens on first use. */
    fun init(context: Context, mb: Int) {
        appContext = context.applicationContext
        limitMb = sizeOf(mb)
    }

    /** One of [SIZES_MB]; anything else is the default. */
    fun sizeOf(mb: Int): Int = if (mb in SIZES_MB) mb else DEFAULT_MB

    /** The open cache, opening it if needed; null when it can't be (no context yet, a disk error). Never on the main thread. */
    @Synchronized
    fun open(): SimpleCache? {
        cache?.let { return it }
        val ctx = appContext ?: return null
        return try {
            // Before the cache's own init thread replays the spans into the evictor: the liked
            // order, the members-only tags and the limit must already be there (a service
            // started without the page, from a media button, must not evict liked songs as if
            // they weren't).
            readIds(ctx, MEMBERS_FILE)?.let { members.load(it) }
            if (!likedKnown) {
                readIds(ctx, LIKED_FILE)?.let { ledger.setLiked(it, known = false) }
                liked = ledger.liked
                likedKnown = liked.isNotEmpty()
            }
            ledger.limit = limitMb * MB
            val c = SimpleCache(File(ctx.cacheDir, DIR), JukeCacheEvictor(), StandaloneDatabaseProvider(ctx))
            cache = c
            c
        } catch (e: Exception) {
            Log.w(TAG, "No listening cache: ${e.javaClass.simpleName}")
            null
        }
    }

    /** Runs [block] with the open cache, under its lock; null without one. */
    private fun <T> locked(block: (SimpleCache) -> T): T? {
        val c = open() ?: return null
        return synchronized(c) { block(c) }
    }

    // ---- reading -----------------------------------------------------------------------------

    /** The keys of [ytId] saved whole, most recently used first. Under the lock. */
    private fun wholeKeys(c: Cache, ytId: String): List<String> = ledger.keysOf(ytId).filter { key ->
        val length = c.getContentMetadata(key).get(ContentMetadata.KEY_CONTENT_LENGTH, -1L)
        CacheKeys.isWhole(length) { c.isCached(key, 0L, it) }
    }

    /**
     * The key of [ytId]'s copy to play from the cache ([CacheKeys.pickKey]: a resume only in the
     * very file it was playing, [keepKey]; else by [rungItag], at least [wantedBps]), or null to
     * load it as usual. Loader thread.
     */
    fun wholeKey(ytId: String, keepKey: String?, rungItag: Int?, wantedBps: Int): String? {
        if (members.denied(ytId)) return null
        return locked { c -> CacheKeys.pickKey(wholeKeys(c, ytId), keepKey, rungItag, wantedBps) }
    }

    /** Whether [ytId] is saved whole (any format). */
    fun isWhole(ytId: String): Boolean = locked { c -> wholeKeys(c, ytId).isNotEmpty() } == true

    /** Signed out: this video's audio may not be cached ([MembersAudio.denied]). */
    fun isDenied(ytId: String): Boolean = members.denied(ytId)

    /**
     * These videos are members-only (queue items, liked tracks): their audio is tagged in the
     * cache. Audio already there is tagged now (signed in) or removed now (signed out), off the
     * calling thread (it may be the main one); a cache not open yet does both as it opens, when
     * it counts its spans.
     */
    fun markMembers(ytIds: Collection<String>) {
        if (ytIds.isEmpty()) return
        ytIds.forEach { members.mark(it) }
        val c = cache ?: return
        Background.run("markMembers") {
            var tagged = false
            synchronized(c) {
                for (id in ytIds) {
                    val keys = ledger.keysOf(id)
                    if (keys.isEmpty()) continue
                    if (members.denied(id)) keys.forEach { c.removeResource(it) } else tagged = members.onCached(id) || tagged
                }
            }
            if (tagged) appContext?.let { writeIds(it, MEMBERS_FILE, members.tagged().toList()) }
        }
    }

    /**
     * The liked songs saved whole, opening the cache if needed (the page asks at start): once
     * the cache has counted what it holds (its lock is held until then).
     */
    fun savedLikedNow(): Set<String> = locked { savedLiked } ?: emptySet()

    // ---- the page's settings (off the main thread; false: no cache) ---------------------------

    /**
     * The liked videos, newest like first. Liked songs are evicted last, least recently liked
     * first; an unliked one is an ordinary listening entry from now on.
     */
    fun setLiked(ytIds: List<String>): Boolean {
        val fresh = locked { c ->
            val known = likedKnown
            likedKnown = true
            val justLiked = ledger.setLiked(ytIds, known)
            liked = ledger.liked
            // Unliked: no longer a saved liked song.
            val dropped = saved.retainAll(liked.toSet())
            refreshSaved(c, liked, dropped)
            publish()
            justLiked
        } ?: return false
        appContext?.let { writeIds(it, LIKED_FILE, liked) }
        likedListeners.forEach { it.onLikedChanged(fresh) }
        return true
    }

    /** The size limit; a smaller one evicts at once (it may delete files). */
    fun setLimitMb(mb: Int): Boolean {
        limitMb = sizeOf(mb)
        return locked { c ->
            ledger.limit = limitMb * MB
            evict(c, 0L, null)
            publish()
        } != null
    }

    /** Clear cache (Settings): everything goes. Playback goes on (from the network). */
    fun clear(): Boolean {
        val done = locked { c -> c.keys.toList().forEach { c.removeResource(it) } } != null
        if (done) {
            Log.i(TAG, "Cleared")
            listeners.forEach { it.onCleared() }
        }
        return done
    }

    /**
     * Signed out (or starting signed out): every tagged or known members-only video's audio goes,
     * and none may come back in until [signedIn]. Cheap when there is none.
     */
    fun signedOut(): Boolean {
        val gone = members.signOut()
        val done = locked { c -> gone.forEach { id -> ledger.keysOf(id).forEach { c.removeResource(it) } } } != null
        appContext?.let { writeIds(it, MEMBERS_FILE, emptyList()) }
        if (gone.isNotEmpty()) Log.i(TAG, "Members-only audio removed")
        return done
    }

    fun signedIn() = members.signIn()

    /**
     * A source that writes what it reads into the cache, for the liked saver; null without a
     * cache. Without FLAG_BLOCK_ON_CACHE it never waits for a span playback is writing: it reads
     * past it from the network instead (not cached then). Without FLAG_IGNORE_CACHE_ON_ERROR
     * (unlike playback's, [CacheRouter]) a cache that can't be written fails the save at once,
     * into the saver's back-off, instead of downloading the song past the cache for nothing.
     */
    fun downloadSource(): CacheDataSource? {
        val c = open() ?: return null
        return CacheDataSource(c, CacheMissGuard(OkHttpDataSource.Factory(Http.streaming).createDataSource()), 0)
    }

    /** Playback's data sources: YouTube audio through the cache, the rest straight to [upstream]. */
    fun dataSourceFactory(upstream: DataSource.Factory): DataSource.Factory = CacheRouter.Factory(upstream)

    // ---- under the lock -----------------------------------------------------------------------

    private fun evict(c: Cache, extra: Long, protect: String?) {
        for (key in ledger.victims(extra, protect)) c.removeResource(key)
    }

    /** Rechecks which of [ytIds] (liked ones) are saved whole; tells the listeners when that changed. */
    private fun refreshSaved(c: Cache, ytIds: Collection<String>, changedAlready: Boolean = false) {
        var changed = changedAlready
        for (id in ytIds) {
            val whole = ledger.isLiked(id) && wholeKeys(c, id).isNotEmpty()
            changed = (if (whole) saved.add(id) else saved.remove(id)) || changed
        }
        if (!changed) return
        savedLiked = HashSet(saved)
        listeners.forEach { it.onSavedChanged() }
    }

    private fun publish() {
        likedFull = ledger.likedFull(LikedSaverPolicy.LISTENING_RESERVE_BYTES)
    }

    /** Counts the cache's spans into the [ledger] and evicts by its order (incremental, no scans). */
    private class JukeCacheEvictor : CacheEvictor {
        override fun requiresCacheSpanTouches(): Boolean = true

        override fun onCacheInitialized() = Unit

        override fun onStartFile(cache: Cache, key: String, position: Long, length: Long) {
            if (length > 0) evict(cache, length, key)
        }

        override fun onSpanAdded(cache: Cache, span: CacheSpan) {
            ledger.onAdded(span.key, span.length, span.lastTouchTimestamp)
            val ytId = CacheKeys.ytIdOf(span.key)
            // Signed out, members-only audio that slipped in (a load already under way) goes.
            if (ytId != null && members.denied(ytId)) {
                cache.removeResource(span.key)
                return
            }
            if (ytId != null && members.onCached(ytId)) {
                appContext?.let { writeIds(it, MEMBERS_FILE, members.tagged().toList()) }
            }
            evict(cache, 0L, span.key)
            changed(cache, span.key)
        }

        override fun onSpanRemoved(cache: Cache, span: CacheSpan) {
            ledger.onRemoved(span.key, span.length)
            changed(cache, span.key)
        }

        override fun onSpanTouched(cache: Cache, oldSpan: CacheSpan, newSpan: CacheSpan) {
            ledger.onTouched(newSpan.key, newSpan.lastTouchTimestamp)
        }

        private fun changed(cache: Cache, key: String) {
            val ytId = CacheKeys.ytIdOf(key) ?: return
            if (ledger.isLiked(ytId) || ytId in saved) refreshSaved(cache, listOf(ytId))
            publish()
        }
    }

    // ---- id lists on disk (beside the cache: never backed up) ---------------------------------

    private fun readIds(ctx: Context, name: String): List<String>? = try {
        File(ctx.cacheDir, name).takeIf { it.isFile }?.readLines()?.filter { SessionPolicy.isValidYtId(it) }
    } catch (e: IOException) {
        null
    }

    private fun writeIds(ctx: Context, name: String, ids: List<String>) {
        try {
            val f = File(ctx.cacheDir, name)
            if (ids.isEmpty()) {
                f.delete()
                return
            }
            val tmp = File(ctx.cacheDir, "$name.tmp")
            tmp.writeText(ids.joinToString("\n"))
            if (!tmp.renameTo(f)) tmp.delete()
        } catch (e: IOException) {
            Log.w(TAG, "Id list not written: ${e.javaClass.simpleName}")
        }
    }
}

/** Read past a cached track's end: it was evicted after the resolver chose it. The load retries (and extracts). */
internal class CacheMissException : IOException("Not in the listening cache any more")

/**
 * [AudioCache.dataSourceFactory]'s sources: a load with a YouTube cache key ([CacheKeys]) goes
 * through the cache (reads what's there, writes what it fetches, also when the response doesn't
 * say its length: [CacheKeys.cacheFlags]), anything else (the CI tone, HLS) straight to the
 * upstream, as does a members-only video while signed out or one whose copy was just found
 * missing or unreadable ([AudioCache.misses]). Without a cache, everything goes straight.
 *
 * The cache can never stop the track: playback's [CacheDataSource] has FLAG_IGNORE_CACHE_ON_ERROR,
 * as InnerTune's and Metrolist's do. A cache error (a span file gone or unreadable, a write
 * failing for low storage or a broken index) still fails that load once, and the cache drops the
 * broken span; the retry ([JukeLoadErrorPolicy], [LoadRetry.cacheFileRetryMs]) then reopens
 * the same source, which bypasses the cache for that request and reads the network. A copy found
 * missing is also remembered ([AudioCache.misses]), so [StreamResolver.cachedKey] stops handing
 * out its key and the retry resolves a stream URL instead of the `cyberjuke://` one. The liked
 * saver's [AudioCache.downloadSource] has no such flag: a CacheWriter that can't write must
 * fail, into the saver's back-off ([SaveStrikes]), not read the whole song for nothing.
 */
@OptIn(UnstableApi::class)
internal class CacheRouter(private val cached: DataSource?, private val plain: DataSource) : DataSource {
    private var current: DataSource? = null

    override fun addTransferListener(transferListener: TransferListener) {
        cached?.addTransferListener(transferListener)
        plain.addTransferListener(transferListener)
    }

    override fun open(dataSpec: DataSpec): Long {
        val key = dataSpec.key
        // Not a members-only video while signed out, nor one whose cached copy was just found
        // missing or unreadable (its retry reads the network, not the same file).
        val viaCache = cached != null && key != null && CacheKeys.isYt(key) &&
            CacheKeys.ytIdOf(key)?.let { AudioCache.isDenied(it) || AudioCache.misses.recent(it) } != true
        val ds = if (viaCache) cached else plain
        current = ds
        // Cached even when the response has no length ([CacheKeys.cacheFlags]).
        return ds.open(if (viaCache) dataSpec.buildUpon().setFlags(CacheKeys.cacheFlags(dataSpec.flags)).build() else dataSpec)
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
        current?.read(buffer, offset, length) ?: throw IOException("Not open")

    override fun getUri(): Uri? = current?.uri

    override fun getResponseHeaders(): Map<String, List<String>> = current?.responseHeaders ?: emptyMap()

    override fun close() {
        val ds = current ?: return
        current = null
        ds.close()
    }

    class Factory(private val upstream: DataSource.Factory) : DataSource.Factory {
        override fun createDataSource(): DataSource {
            val c = AudioCache.open()
            val cached = c?.let { CacheDataSource(it, CacheMissGuard(upstream.createDataSource()), CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR) }
            return CacheRouter(cached, upstream.createDataSource())
        }
    }
}

/**
 * The cache's upstream.
 * - A track played from the cache keeps our own `cyberjuke://` URI (it has no stream URL): if
 *   any of it is missing after all, reading fails at once ([CacheMissException], no request), the
 *   video is skipped by the cache for a moment ([AudioCache.misses]), and the load's retry
 *   resolves it as usual.
 * - It reports the URL it was asked for, never one a redirect led to, so the cache doesn't store
 *   a googlevideo URL in its index (stream URLs stay in memory only).
 */
@OptIn(UnstableApi::class)
internal class CacheMissGuard(private val inner: DataSource) : DataSource {
    private var asked: Uri? = null

    override fun addTransferListener(transferListener: TransferListener) = inner.addTransferListener(transferListener)

    override fun open(dataSpec: DataSpec): Long {
        if (dataSpec.uri.scheme == JukeUris.SCHEME) {
            JukeUris.ytIdOf(dataSpec.uri)?.let { AudioCache.misses.missed(it) }
            throw CacheMissException()
        }
        asked = dataSpec.uri
        return inner.open(dataSpec)
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int = inner.read(buffer, offset, length)

    override fun getUri(): Uri? = asked

    override fun getResponseHeaders(): Map<String, List<String>> = inner.responseHeaders

    override fun close() {
        asked = null
        inner.close()
    }
}
