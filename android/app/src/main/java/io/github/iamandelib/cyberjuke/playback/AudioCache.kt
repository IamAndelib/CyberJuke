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
 *   first use off the main thread and released when the playback service goes.
 * - Keys are `yt:<ytId>:<itag>` ([CacheKeys]), set by [YtDataSpecResolver]; only those go
 *   through the cache ([CacheRouter]), so the CI tone and HLS are untouched.
 * - A track saved whole plays from it with no extraction and no request
 *   ([StreamResolver.cachedKey]).
 * - Which liked songs are saved whole is kept up to date from the span callbacks and sent to
 *   the page as `cacheChanged` (only when that set changes).
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

    const val DEFAULT_MB = 256
    val SIZES_MB = listOf(128, 256, 512)
    private const val MB = 1024L * 1024L

    /** The liked songs saved whole changed ([savedLiked]); any thread. */
    fun interface Listener {
        fun onSavedChanged()
    }

    /** The liked list changed; [fresh]: liked since the last list (just now). Any thread. */
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
    private var database: StandaloneDatabaseProvider? = null

    /** The limit in MB (Settings), kept to apply when the cache opens. */
    @Volatile
    private var limitMb = DEFAULT_MB

    /** Guarded by the open cache's lock (see the class comment). */
    private val ledger = CacheLedger(DEFAULT_MB * MB)

    /** Liked songs saved whole, guarded like [ledger]. */
    private val saved = HashSet<String>()

    /** The liked list came from the page or the file (until then no like is "fresh"). */
    private var likedKnown = false

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
            // order and the limit must already be there (a service started without the page,
            // from a media button, must not evict liked songs as if they weren't).
            ledger.clearEntries()
            saved.clear()
            savedLiked = emptySet()
            if (!likedKnown) {
                readLikedFile(ctx)?.let { ledger.setLiked(it, known = false) }
                liked = ledger.liked
                likedKnown = liked.isNotEmpty()
            }
            ledger.limit = limitMb * MB
            val db = StandaloneDatabaseProvider(ctx)
            val c = SimpleCache(File(ctx.cacheDir, DIR), JukeCacheEvictor(), db)
            database = db
            cache = c
            c
        } catch (e: Exception) {
            Log.w(TAG, "No listening cache: ${e.javaClass.simpleName}")
            null
        }
    }

    /** The playback service is going: the index is written and the folder freed. */
    @Synchronized
    fun release() {
        val c = cache ?: return
        cache = null
        try {
            c.release()
        } catch (e: Exception) {
            Log.w(TAG, "Cache release failed: ${e.javaClass.simpleName}")
        }
        runCatching { database?.close() }
        database = null
    }

    /** Runs [block] with the open cache, under its lock; null without one (or released meanwhile). */
    private fun <T> locked(block: (SimpleCache) -> T): T? {
        val c = open() ?: return null
        return try {
            synchronized(c) { block(c) }
        } catch (e: IllegalStateException) { // released meanwhile
            null
        }
    }

    // ---- reading -----------------------------------------------------------------------------

    /** The formats of [ytId] saved whole, most recently used first. Under the lock. */
    private fun wholeItags(c: Cache, ytId: String): List<Int> = ledger.keysOf(ytId).filter { key ->
        val length = c.getContentMetadata(key).get(ContentMetadata.KEY_CONTENT_LENGTH, -1L)
        CacheKeys.isWhole(length) { c.isCached(key, 0L, it) }
    }.mapNotNull { CacheKeys.itagOf(it) }

    /** The format of [ytId] to play from the cache ([CacheKeys.pick]), or null. Loader thread. */
    fun wholeItag(ytId: String, keep: Int?, rungItag: Int?): Int? =
        locked { c -> CacheKeys.pick(wholeItags(c, ytId), keep, rungItag) }

    /** Whether [ytId] is saved whole (any format). */
    fun isWhole(ytId: String): Boolean = locked { c -> wholeItags(c, ytId).isNotEmpty() } == true

    /**
     * The liked songs saved whole, opening the cache if needed (the page asks at start): once
     * the cache has counted what it holds (its lock is held until then).
     */
    fun savedLikedNow(): Set<String> = locked { savedLiked } ?: emptySet()

    // ---- the page's settings ------------------------------------------------------------------

    /**
     * The liked videos, newest like first. Liked songs are evicted last, least recently liked
     * first; an unliked one is an ordinary listening entry from now on.
     */
    fun setLiked(ytIds: List<String>) {
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
        } ?: return
        appContext?.let { writeLikedFile(it, liked) }
        likedListeners.forEach { it.onLikedChanged(fresh) }
    }

    /** The size limit; a smaller one evicts at once. Call off the main thread (it may delete files). */
    fun setLimitMb(mb: Int) {
        limitMb = sizeOf(mb)
        locked { c ->
            ledger.limit = limitMb * MB
            evict(c, 0L, null)
            publish()
        }
    }

    /** Clear cache (Settings): everything goes. Playback goes on (from the network). Off the main thread. */
    fun clear() {
        locked { c -> c.keys.toList().forEach { c.removeResource(it) } }
        Log.i(TAG, "Cleared")
    }

    /** Signed out: the audio of these (members-only) videos goes. Off the main thread. */
    fun drop(ytIds: Collection<String>) {
        locked { c -> ytIds.forEach { id -> ledger.keysOf(id).forEach { c.removeResource(it) } } }
    }

    /** A source that writes what it reads into the cache, for the liked saver; null without a cache. */
    fun downloadSource(): CacheDataSource? {
        val c = open() ?: return null
        return CacheDataSource.Factory()
            .setCache(c)
            .setUpstreamDataSourceFactory(OkHttpDataSource.Factory(Http.streaming))
            // Never waits for a span playback is writing (it reads past it instead).
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
            .createDataSource()
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
            val whole = ledger.isLiked(id) && wholeItags(c, id).isNotEmpty()
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

    // ---- the liked list on disk ---------------------------------------------------------------

    private fun readLikedFile(ctx: Context): List<String>? = try {
        File(ctx.cacheDir, LIKED_FILE).takeIf { it.isFile }?.readLines()?.filter { SessionPolicy.isValidYtId(it) }
    } catch (e: IOException) {
        null
    }

    private fun writeLikedFile(ctx: Context, ids: List<String>) {
        try {
            val f = File(ctx.cacheDir, LIKED_FILE)
            val tmp = File(ctx.cacheDir, "$LIKED_FILE.tmp")
            tmp.writeText(ids.joinToString("\n"))
            if (!tmp.renameTo(f)) tmp.delete()
        } catch (e: IOException) {
            Log.w(TAG, "Liked list not written: ${e.javaClass.simpleName}")
        }
    }
}

/** Read past a cached track's end: it was evicted after the resolver chose it. The load retries (and extracts). */
internal class CacheMissException : IOException("Not in the listening cache any more")

/**
 * [AudioCache.dataSourceFactory]'s sources: a load with a YouTube cache key ([CacheKeys]) goes
 * through the cache (reads what's there, writes what it fetches), anything else (the CI tone,
 * HLS) straight to the upstream. Without a cache, everything goes straight.
 */
@OptIn(UnstableApi::class)
internal class CacheRouter(private val cached: DataSource?, private val plain: DataSource) : DataSource {
    private var current: DataSource? = null

    override fun addTransferListener(transferListener: TransferListener) {
        cached?.addTransferListener(transferListener)
        plain.addTransferListener(transferListener)
    }

    override fun open(dataSpec: DataSpec): Long {
        val ds = if (cached != null && CacheKeys.isYt(dataSpec.key)) cached else plain
        current = ds
        return ds.open(dataSpec)
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
            val cached = c?.let {
                CacheDataSource(it, CacheMissGuard(upstream.createDataSource()), CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
            }
            return CacheRouter(cached, upstream.createDataSource())
        }
    }
}

/**
 * The cache's upstream. A track played from the cache keeps our own `cyberjuke://` URI (it has
 * no stream URL): if any of it is missing after all, reading fails at once ([CacheMissException],
 * no request), and the load's retry resolves it as usual.
 */
@OptIn(UnstableApi::class)
internal class CacheMissGuard(private val inner: DataSource) : DataSource {
    override fun addTransferListener(transferListener: TransferListener) = inner.addTransferListener(transferListener)

    override fun open(dataSpec: DataSpec): Long {
        if (dataSpec.uri.scheme == JukeUris.SCHEME) throw CacheMissException()
        return inner.open(dataSpec)
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int = inner.read(buffer, offset, length)

    override fun getUri(): Uri? = inner.uri

    override fun getResponseHeaders(): Map<String, List<String>> = inner.responseHeaders

    override fun close() = inner.close()
}
