package io.github.iamandelib.cyberjuke.playback

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.FileDataSource
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
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The listening cache: the audio of recently played and next tracks and of liked songs, on the
 * phone only (noBackupFilesDir/audio, which Android never clears and never backs up, as Metrolist
 * keeps its caches out of cacheDir; its index is in the ExoPlayer database, kept out of backups
 * by the backup rules). Up to the
 * size chosen in Settings (128, 256 or 512 MB); over it, [CacheLedger]'s order decides what goes.
 *
 * - One [SimpleCache] for the process (it refuses a second one on the same folder), opened on
 *   first use off the main thread and kept open for the process's life: never released, so
 *   nothing blocks the main thread in onDestroy, and nothing is lost when the process dies
 *   (every span is indexed as it is written). One that fails to start is released and not tried
 *   again in the process ([startFailed]): playback streams.
 * - Keys are `yt:<ytId>:<itag>:<clen>`, and `mp3:<file>` for a Jukebox MP3 ([CacheKeys]), set
 *   by [YtDataSpecResolver]; only those go through the cache ([CacheRouter]), so the CI tone
 *   and HLS are untouched. Everything else here (liked, saved, members-only) goes by the audio
 *   id the key keeps ([CacheKeys.audioIdOf]): a video id or an MP3's `mp3:<file>`.
 * - A track saved whole plays from it with no extraction and no request
 *   ([StreamResolver.cachedKey]; an MP3 by its key alone, [YtDataSpecResolver]).
 * - Which liked songs are saved whole is kept up to date from the span callbacks and sent to
 *   the page as `cacheChanged` (only when that set changes).
 * - Members-only audio is tagged as it comes in ([MembersAudio], the tags in a file beside the
 *   cache), so signing out ([signedOut]) removes all of it, and none comes back in until a
 *   sign-in.
 * - No googlevideo URL is kept: the upstream ([CacheMissGuard]) reports the URL it was asked
 *   for, so the cache never records a redirect.
 * - Beside it, the saved store (noBackupFilesDir/saved, the same keys, never evicted): the liked
 *   songs saved for offline, as NewPipe, InnerTune and Metrolist keep downloads apart from their
 *   player cache. It is read first ([CacheRouter], [wholeKey]); members-only audio and a song
 *   discarded leave both, Clear cache only the listening cache. Opened with it, sharing its
 *   database (two SimpleCaches may, in different folders); one that fails to start is left out.
 *
 * Threads: the ledger and the saved set are only touched under the cache's own lock (its span
 * callbacks hold it; everything else takes it). The main thread only reads the published
 * snapshots ([savedLiked], [liked], [likedFull]) and [downloadOnMobileData], never the cache itself. Nothing here runs on a
 * timer.
 */
@OptIn(UnstableApi::class)
internal object AudioCache {
    private const val TAG = "CyberJukeCache"

    /** In noBackupFilesDir: the SimpleCache folder, the liked list (newest first), the members-only tags. */
    private const val DIR = "audio"
    private const val SAVED_DIR = "saved"
    private const val LIKED_FILE = "audio-liked"
    private const val MEMBERS_FILE = "audio-members"

    const val DEFAULT_MB = 256
    val SIZES_MB = listOf(128, 256, 512)
    private const val MB = 1024L * 1024L

    /** The liked songs saved whole changed ([savedLiked]), the cache was cleared, or Download using mobile data changed; any thread. */
    fun interface Listener {
        fun onSavedChanged()

        /** Clear cache emptied it. */
        fun onCleared() = Unit

        /** Download using mobile data ([downloadOnMobileData]) was turned on or off. */
        fun onMobileDataChanged() = Unit
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

    /** The saved store, opened with [cache] (null: not yet, none, or it failed to start). */
    @Volatile
    var savedStore: SimpleCache? = null
        private set

    /** The saved store failed to start, even wiped: liked songs aren't saved in this process ([LikedSaverPolicy.Facts.cache]). */
    @Volatile
    var savedFailed = false
        private set

    /** What [savedStore] holds (its own lock, a leaf). */
    private val savedKeys = SavedKeys()

    /**
     * The cache failed to start: not tried again in this process. Another start would count every
     * span into the [ledger] a second time (and evict real files for bytes that aren't there), and
     * would be rebuilt on every call, the playback thread's included. Playback streams meanwhile.
     */
    @Volatile
    var startFailed = false
        private set

    /** The limit in MB (Settings), kept to apply when the cache opens. */
    @Volatile
    private var limitMb = DEFAULT_MB

    /** Guarded by the open cache's lock (see the class comment). */
    private val ledger = CacheLedger(DEFAULT_MB * MB)

    /** Liked songs saved whole (in either store), guarded like [ledger]. */
    private val saved = HashSet<String>()

    /** Of those, the ones whole in the saved store ([inStore]), and the ones whole only in the listening cache ([copyable]). */
    private val stored = HashSet<String>()
    private val copies = HashSet<String>()

    /** The liked list came from the page or the file (until then no like is "fresh"). */
    private var likedKnown = false

    /** Members-only audio (thread-safe itself). */
    private val members = MembersAudio()

    /** Copies just found missing: not served from the cache for a moment ([CacheMissGuard]). */
    val misses = CacheMisses()

    /** [online] flipped; any thread. */
    fun interface OnlineListener {
        fun onOnlineChanged(online: Boolean)
    }

    private val onlineListeners = CopyOnWriteArraySet<OnlineListener>()
    private val onlineRef = AtomicBoolean(true)

    fun addOnlineListener(l: OnlineListener) = onlineListeners.add(l)
    fun removeOnlineListener(l: OnlineListener) = onlineListeners.remove(l)

    /**
     * The device has a validated network (PlaybackService's network callback): online, a lower
     * copy doesn't stand in, and the `state` event's waiting for carrier reads it. A flip reaches
     * the [OnlineListener]s (the plugin sends a state).
     */
    var online: Boolean
        get() = onlineRef.get()
        set(value) {
            if (onlineRef.getAndSet(value) != value) onlineListeners.forEach { it.onOnlineChanged(value) }
        }

    /** Stops the liked save in progress, if any (LikedSaver sets it while one runs). */
    @Volatile
    var cancelSave: (() -> Unit)? = null

    /** The liked songs saved whole, in either store: they play offline (a snapshot; any thread). */
    @Volatile
    var savedLiked: Set<String> = emptySet()
        private set

    /** The liked songs whole in the saved store: the saver is done with them (a snapshot). */
    @Volatile
    var inStore: Set<String> = emptySet()
        private set

    /** The liked songs whole in the listening cache but not yet in the saved store: copied, no network needed (a snapshot). */
    @Volatile
    var copyable: Set<String> = emptySet()
        private set

    /** The liked songs (audio ids), newest like first (a snapshot). */
    @Volatile
    var liked: List<String> = emptyList()
        private set

    /** Liked songs fill the cache: the backfill waits ([LikedSaverPolicy]). */
    @Volatile
    var likedFull: Boolean = false
        private set

    /** Settings' Download using mobile data: liked songs are saved on any network, not only Wi-Fi. */
    @Volatile
    var downloadOnMobileData: Boolean = false
        private set

    /**
     * Cheap: remembers the context, the limit and [downloadOnMobileData]. The cache itself opens on
     * first use. The saved setting is taken only by the first call (the service's or the bridge's):
     * a later one could carry a value read before a change the page has sent since.
     */
    fun init(context: Context, mb: Int, mobileData: Boolean) {
        if (appContext == null) downloadOnMobileData = mobileData
        appContext = context.applicationContext
        limitMb = sizeOf(mb)
    }

    /** The size limit now (Settings), in bytes. */
    val limitBytes: Long
        get() = limitMb * MB

    /** One of [SIZES_MB]; anything else is the default. */
    fun sizeOf(mb: Int): Int = if (mb in SIZES_MB) mb else DEFAULT_MB

    /**
     * The open cache, opening it if needed (that waits while it counts what it holds); null when
     * it can't be (no context yet, or it failed to start: [startFailed]): playback then streams.
     * Never on the main thread.
     */
    @Synchronized
    fun open(): SimpleCache? {
        cache?.let { return it }
        if (startFailed) return null
        val ctx = appContext ?: return null
        return try {
            val db = StandaloneDatabaseProvider(ctx)
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
            // Before the listening cache, so its count already sees what is saved.
            savedStore = openSaved(File(ctx.noBackupFilesDir, SAVED_DIR), db)
            val dir = File(ctx.noBackupFilesDir, DIR)
            // Failed to start (its folder or index unreadable), it would fail every read and
            // write: wiped and started once more, empty (CacheStart); failing again, none, and
            // playback streams.
            val c = try {
                CacheStart.openOrWipe(
                    open = { start(dir, db, JukeCacheEvictor()) { forgetFailedStart(it) } },
                    wipe = {
                        Log.w(TAG, "Listening cache damaged: starting it empty")
                        SimpleCache.delete(dir, db)
                    },
                    damaged = { it is Cache.CacheException },
                )
            } catch (e: Cache.CacheException) {
                startFailed = true
                Log.w(TAG, "Listening cache failed to start: ${(e.cause ?: e).javaClass.simpleName}")
                return null
            }
            cache = c
            // Marked while it started (markMembers had no cache to go through yet), after their
            // audio was counted in: tagged or removed now, every song marked so far.
            Background.run("markMembers") { reconcileMembers(c, members.marked()) }
            c
        } catch (e: Exception) {
            startFailed = true
            Log.w(TAG, "No listening cache: ${e.javaClass.simpleName}")
            null
        }
    }

    /** A cache over [dir], its index read; a [Cache.CacheException] when that fails (released, then [failed]). */
    private fun start(dir: File, db: StandaloneDatabaseProvider, evictor: CacheEvictor, failed: (SimpleCache) -> Unit): SimpleCache {
        val c = SimpleCache(dir, evictor, db)
        try {
            c.checkInitialization()
        } catch (e: Cache.CacheException) {
            try {
                c.release()
            } finally {
                failed(c)
            }
            throw e
        }
        return c
    }

    /** The saved store, wiped once if damaged ([CacheStart]); null if it still fails: the listening cache goes on alone. */
    private fun openSaved(dir: File, db: StandaloneDatabaseProvider): SimpleCache? = try {
        CacheStart.openOrWipe(
            open = { start(dir, db, SavedEvictor()) { savedKeys.clear() } },
            wipe = {
                Log.w(TAG, "Saved store damaged: starting it empty")
                SimpleCache.delete(dir, db)
            },
            damaged = { it is Cache.CacheException },
        )
    } catch (e: Exception) {
        savedFailed = true
        Log.w(TAG, "No saved store: ${e.javaClass.simpleName}")
        null
    }

    /**
     * The failed start had counted the spans on disk into the [ledger], and may have found liked
     * songs saved (and told the page): none of it plays, so it is all forgotten, and the page told.
     * After [Cache.release], which may still report spans removed.
     */
    private fun forgetFailedStart(c: SimpleCache) {
        val hadSaved = synchronized(c) {
            ledger.resetSpans()
            val had = saved.isNotEmpty() || savedLiked.isNotEmpty()
            saved.clear()
            stored.clear()
            copies.clear()
            savedLiked = emptySet()
            inStore = emptySet()
            copyable = emptySet()
            publish()
            had
        }
        if (hadSaved) listeners.forEach { it.onSavedChanged() }
    }

    /** Runs [block] with the open cache, under its lock; null without one. */
    private fun <T> locked(block: (SimpleCache) -> T): T? {
        val c = open() ?: return null
        return synchronized(c) { block(c) }
    }

    // ---- reading -----------------------------------------------------------------------------

    /** The keys of [audioId] whole in the saved store, then those whole in the listening cache (most recently used first). Under the lock. */
    private fun wholeKeys(c: Cache, audioId: String): List<String> = CacheKeys.wholeOf(storedKeys(audioId), listeningKeys(c, audioId))

    /** [audioId]'s keys whole in the saved store. */
    private fun storedKeys(audioId: String): List<String> {
        val s = savedStore ?: return emptyList()
        return savedKeys.keysOf(audioId).filter { isWhole(s, it) }
    }

    /** [audioId]'s keys whole in the listening cache, most recently used first. Under its lock. */
    private fun listeningKeys(c: Cache, audioId: String): List<String> = ledger.keysOf(audioId).filter { isWhole(c, it) }

    private fun isWhole(c: Cache, key: String): Boolean {
        val length = c.getContentMetadata(key).get(ContentMetadata.KEY_CONTENT_LENGTH, -1L)
        return CacheKeys.isWhole(length) { c.isCached(key, 0L, it) }
    }

    /** [audioId]'s audio goes from both stores. Under the listening cache's lock (the saved store's is taken inside it, never the other way). */
    private fun removeAudio(c: Cache, audioId: String) {
        ledger.keysOf(audioId).forEach { c.removeResource(it) }
        savedStore?.let { s -> savedKeys.keysOf(audioId).forEach { s.removeResource(it) } }
    }

    /**
     * The key of [audioId]'s copy to play from the cache ([CacheKeys.pickFor]: for a video a
     * resume only in the very file it was playing, [keepKey]; else by [rungItag], at least
     * [wantedBps]; a Jukebox MP3's one file), or null to load it as usual. Loader thread.
     */
    fun wholeKey(audioId: String, keepKey: String? = null, rungItag: Int? = null, wantedBps: Int = 0): String? {
        if (members.denied(audioId)) return null
        return locked { c -> CacheKeys.pickFor(audioId, wholeKeys(c, audioId), keepKey, rungItag, wantedBps) }
    }

    /** Whether [audioId] is saved whole (any format). */
    fun isWhole(audioId: String): Boolean = locked { c -> wholeKeys(c, audioId).isNotEmpty() } == true

    /** Whether [audioId] is whole in the saved store (the saver's job is done). */
    fun isStored(audioId: String): Boolean = locked { storedKeys(audioId).isNotEmpty() } == true

    /** The key of [audioId]'s whole listening copy to copy into the saved store, or null (none). */
    fun listeningCopy(audioId: String): String? = locked { c -> listeningKeys(c, audioId).firstOrNull() }

    /** Signed out: this track's audio may not be cached ([MembersAudio.denied]). */
    fun isDenied(audioId: String): Boolean = members.denied(audioId)

    /**
     * These audio ids are members-only (queue items, liked tracks): their audio is tagged in the
     * cache. Audio already there is tagged now (signed in) or removed now (signed out), off the
     * calling thread (it may be the main one); a cache not open yet does both as it opens, when
     * it counts its spans, and once it has started for marks that came while it counted.
     */
    fun markMembers(ids: Collection<String>) {
        if (ids.isEmpty()) return
        ids.forEach { members.mark(it) }
        val c = cache ?: return
        Background.run("markMembers") { reconcileMembers(c, ids) }
    }

    /**
     * The audio of these members-only tracks already in the cache: tagged, or removed while
     * signed out ([MembersAudio.reconcile]). Off the calling thread, under the cache's lock.
     */
    private fun reconcileMembers(c: SimpleCache, ids: Collection<String>) {
        val r = synchronized(c) {
            members.reconcile(ids.filter { ledger.keysOf(it).isNotEmpty() || savedKeys.keysOf(it).isNotEmpty() }).also { r ->
                r.remove.forEach { removeAudio(c, it) }
            }
        }
        if (r.tagged) appContext?.let { writeIds(it, MEMBERS_FILE, members.tagged().toList()) }
    }

    /**
     * The liked songs saved whole, opening the cache if needed (the page asks at start): once
     * the cache has counted what it holds (its lock is held until then).
     */
    fun savedLikedNow(): Set<String> = locked { savedLiked } ?: emptySet()

    // ---- the page's settings (off the main thread; false: no cache) ---------------------------

    /**
     * The liked audio ids (videos and Jukebox MP3s), newest like first. Liked songs are evicted
     * last, least recently liked first; an unliked one is an ordinary listening entry from now on.
     */
    fun setLiked(ids: List<String>): Boolean {
        val fresh = locked { c ->
            val known = likedKnown
            likedKnown = true
            val justLiked = ledger.setLiked(ids, known)
            liked = ledger.liked
            // Unliked: no longer a saved liked song.
            val keep = liked.toSet()
            val dropped = saved.retainAll(keep) or stored.retainAll(keep) or copies.retainAll(keep)
            refreshSaved(c, liked, dropped)
            publish()
            justLiked
        } ?: return false
        appContext?.let { writeIds(it, LIKED_FILE, liked) }
        likedListeners.forEach { it.onLikedChanged(fresh) }
        return true
    }

    /** Download using mobile data (Settings); the saver hears it at once (no cache needed). */
    fun setDownloadOnMobileData(on: Boolean) {
        if (on == downloadOnMobileData) return
        downloadOnMobileData = on
        listeners.forEach { it.onMobileDataChanged() }
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

    /** [audioId]'s audio goes: a liked save too big to keep ([LikedSaverPolicy.tooBig]). */
    fun discard(audioId: String) {
        locked { c -> removeAudio(c, audioId) }
    }

    /** Clear cache (Settings): the listening cache empties (the saved store stays). Playback goes on (from the network). */
    fun clear(): Boolean {
        val done = locked { c -> c.keys.toList().forEach { c.removeResource(it) } } != null
        if (done) {
            Log.i(TAG, "Cleared")
            listeners.forEach { it.onCleared() }
        }
        return done
    }

    /**
     * Signed out (or starting signed out): every tagged or known members-only song's audio goes,
     * and none may come back in until [signedIn]. Cheap when there is none.
     */
    fun signedOut(): Boolean {
        val gone = members.signOut()
        val done = locked { c -> gone.forEach { removeAudio(c, it) } } != null
        // No cache (it didn't start): the audio is still on the phone, so its tags stay written
        // down, and the sign-out at the next start removes it.
        if (done) members.removed(gone)
        appContext?.let { writeIds(it, MEMBERS_FILE, members.tagged().toList()) }
        if (gone.isNotEmpty()) Log.i(TAG, "Members-only audio removed")
        return done
    }

    fun signedIn() = members.signIn()

    /**
     * A source that writes what it reads into the saved store, for the liked saver; null without
     * both stores. It reads what the listening cache has of the song first (a whole copy there is
     * copied, with no request), only the rest from the network, and writes nothing into the
     * listening cache: one copy of a saved song. Without FLAG_BLOCK_ON_CACHE it never waits for
     * a span being written: it reads past it instead (not saved then). Without
     * FLAG_IGNORE_CACHE_ON_ERROR (unlike playback's, [CacheRouter]) a store that can't be written
     * fails the save at once, into the saver's back-off, instead of downloading the song for nothing.
     */
    fun saveSource(): CacheDataSource? {
        val c = open() ?: return null
        val s = savedStore ?: return null
        val listening = CacheDataSource(c, CacheMissGuard(OkHttpDataSource.Factory(Http.streaming).createDataSource()), FileDataSource(), null, 0, null)
        return CacheDataSource(s, listening, 0)
    }

    /** Playback's data sources: YouTube audio and Jukebox MP3s through the cache, the rest straight to [upstream]. */
    fun dataSourceFactory(upstream: DataSource.Factory): DataSource.Factory = CacheRouter.Factory(upstream)

    // ---- under the lock -----------------------------------------------------------------------

    private fun evict(c: Cache, extra: Long, protect: String?) {
        for (key in ledger.victims(extra, protect)) c.removeResource(key)
    }

    /** Rechecks which of [ids] (liked ones) are saved whole, and where; tells the listeners when that changed. */
    private fun refreshSaved(c: Cache, ids: Collection<String>, changedAlready: Boolean = false) {
        var changed = changedAlready
        for (id in ids) {
            val liked = ledger.isLiked(id)
            val inStore = liked && storedKeys(id).isNotEmpty()
            val inListening = liked && listeningKeys(c, id).isNotEmpty()
            changed = (mark(saved, id, inStore || inListening) or mark(stored, id, inStore) or mark(copies, id, inListening && !inStore)) || changed
        }
        if (!changed) return
        savedLiked = HashSet(saved)
        inStore = HashSet(stored)
        copyable = HashSet(copies)
        listeners.forEach { it.onSavedChanged() }
    }

    /** [id] in [set] or not, as [on] says; true when that changed. */
    private fun mark(set: MutableSet<String>, id: String, on: Boolean): Boolean = if (on) set.add(id) else set.remove(id)

    private fun publish() {
        likedFull = ledger.likedFull(LikedSaverPolicy.LISTENING_RESERVE_BYTES)
    }

    /** Counts the cache's spans into the [ledger] and evicts by its order (incremental, no scans). */
    private class JukeCacheEvictor : CacheEvictor {
        override fun requiresCacheSpanTouches(): Boolean = true

        override fun onCacheInitialized() = Unit

        // The key being written may go itself: a song that isn't liked, too big to fit beside the
        // liked ones ([CacheLedger.victims]).
        override fun onStartFile(cache: Cache, key: String, position: Long, length: Long) {
            if (length > 0) evict(cache, length, key)
        }

        override fun onSpanAdded(cache: Cache, span: CacheSpan) {
            ledger.onAdded(span.key, span.length, span.lastTouchTimestamp)
            val audioId = CacheKeys.audioIdOf(span.key)
            // Signed out, members-only audio that slipped in (a load already under way) goes.
            if (audioId != null && members.denied(audioId)) {
                cache.removeResource(span.key)
                return
            }
            if (audioId != null && members.onCached(audioId)) {
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
            val audioId = CacheKeys.audioIdOf(key) ?: return
            if (ledger.isLiked(audioId) || audioId in saved) refreshSaved(cache, listOf(audioId))
            publish()
        }
    }

    /**
     * Counts the saved store's spans ([savedKeys]); it never evicts. Called under that store's
     * lock, so the saved set is rechecked afterwards, off it, under the listening cache's.
     */
    private class SavedEvictor : CacheEvictor {
        override fun requiresCacheSpanTouches(): Boolean = false

        override fun onCacheInitialized() = Unit

        override fun onStartFile(cache: Cache, key: String, position: Long, length: Long) = Unit

        override fun onSpanAdded(cache: Cache, span: CacheSpan) {
            savedKeys.onAdded(span.key, span.length)
            val audioId = CacheKeys.audioIdOf(span.key) ?: return
            if (members.denied(audioId)) {
                cache.removeResource(span.key)
                return
            }
            if (members.onCached(audioId)) appContext?.let { writeIds(it, MEMBERS_FILE, members.tagged().toList()) }
            recheck(audioId)
        }

        override fun onSpanRemoved(cache: Cache, span: CacheSpan) {
            savedKeys.onRemoved(span.key, span.length)
            CacheKeys.audioIdOf(span.key)?.let { recheck(it) }
        }

        override fun onSpanTouched(cache: Cache, oldSpan: CacheSpan, newSpan: CacheSpan) = Unit

        private fun recheck(audioId: String) = Background.run("savedChanged") {
            locked { c -> if (ledger.isLiked(audioId) || audioId in saved) refreshSaved(c, listOf(audioId)) }
        }
    }

    // ---- id lists on disk (beside the cache: never cleared, never backed up) -------------------

    private fun readIds(ctx: Context, name: String): List<String>? = try {
        File(ctx.noBackupFilesDir, name).takeIf { it.isFile }?.readLines()?.filter { SessionPolicy.isValidAudioId(it) }
    } catch (e: IOException) {
        null
    }

    private fun writeIds(ctx: Context, name: String, ids: List<String>) {
        try {
            val f = File(ctx.noBackupFilesDir, name)
            if (ids.isEmpty()) {
                f.delete()
                return
            }
            val tmp = File(ctx.noBackupFilesDir, "$name.tmp")
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
 * [AudioCache.dataSourceFactory]'s sources: a load with a YouTube or Jukebox MP3 cache key
 * ([CacheKeys.isCacheable]) goes through the cache (reads what's there, writes what it fetches,
 * also when the response doesn't say its length: [CacheKeys.cacheFlags]), anything else (the CI
 * tone, HLS) straight to the upstream, as does a members-only track while signed out or one
 * whose copy was just found missing or unreadable ([AudioCache.misses]). Without a cache,
 * everything goes straight.
 *
 * The cache can never stop the track: playback's [CacheDataSource] has FLAG_IGNORE_CACHE_ON_ERROR,
 * as InnerTune's and Metrolist's do. A cache error (a span file gone or unreadable, a write
 * failing for low storage or a broken index) still fails that load once, and the cache drops the
 * broken span; the retry ([JukeLoadErrorPolicy], [LoadRetry.cacheFileRetryMs]) then reopens
 * the same source, which bypasses the cache for the rest of that track (the error is remembered
 * per source, and a track keeps its source) and reads the network. A copy found
 * missing is also remembered ([AudioCache.misses]), so [StreamResolver.cachedKey] stops handing
 * out its key and the retry resolves a stream URL instead of the `cyberjuke://` one. The liked
 * saver's [AudioCache.saveSource] has no such flag: a CacheWriter that can't write must
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
        // Not a members-only song while signed out, nor one whose cached copy was just found
        // missing or unreadable (its retry reads the network, not the same file).
        val viaCache = cached != null && key != null && CacheKeys.isCacheable(key) &&
            CacheKeys.audioIdOf(key)?.let { AudioCache.isDenied(it) || AudioCache.misses.recent(it) } != true
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
            val listening = c?.let { CacheDataSource(it, CacheMissGuard(upstream.createDataSource()), CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR) }
            // The saved store first, read only: what it lacks comes through the listening cache.
            val cached = listening?.let { l ->
                AudioCache.savedStore?.let { CacheDataSource(it, l, FileDataSource(), null, CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR, null) } ?: l
            }
            return CacheRouter(cached, upstream.createDataSource())
        }
    }
}

/**
 * The cache's upstream.
 * - A track played from the cache keeps our own `cyberjuke://` URI (it has no stream URL): if
 *   any of it is missing after all, reading fails at once ([CacheMissException], no request), the
 *   song is skipped by the cache for a moment ([AudioCache.misses]), and the load's retry
 *   resolves it as usual.
 * - It reports the URL it was asked for, never one a redirect led to, so the cache doesn't store
 *   a googlevideo URL in its index (stream URLs stay in memory only). A Jukebox MP3 is asked
 *   for by its latex.gg link, which is rebuilt from its key anyway.
 */
@OptIn(UnstableApi::class)
internal class CacheMissGuard(private val inner: DataSource) : DataSource {
    private var asked: Uri? = null

    override fun addTransferListener(transferListener: TransferListener) = inner.addTransferListener(transferListener)

    override fun open(dataSpec: DataSpec): Long {
        if (dataSpec.uri.scheme == JukeUris.SCHEME) {
            JukeUris.audioIdOf(dataSpec.uri)?.let { AudioCache.misses.missed(it) }
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
