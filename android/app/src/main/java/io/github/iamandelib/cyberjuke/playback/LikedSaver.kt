package io.github.iamandelib.cyberjuke.playback

import android.os.Handler
import android.os.SystemClock
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.cache.CacheWriter
import io.github.iamandelib.cyberjuke.findCause
import io.github.iamandelib.cyberjuke.net.Http
import io.github.iamandelib.cyberjuke.net.NetBlock
import java.io.IOException

/**
 * Saves liked songs into the saved store ([AudioCache]), so they play offline ([LikedSaverPolicy] decides
 * when and which), on Wi-Fi only unless Settings' Download using mobile data is on. A song
 * liked just now goes first (usually it is copied from the listening cache, having just played:
 * what plays is kept as it streams, on any network); older likes are filled in one at a time,
 * newest first. A
 * Jukebox MP3 is saved the same way, by its audio id (`mp3:<file>`), with no extraction: its
 * file comes straight from latex.gg, and a YouTube back-off doesn't hold it.
 *
 * Lives in PlaybackService, so it only runs while the service already does (the app is open or
 * playing): no job, no alarm, nothing that wakes the phone. Event-driven: asked again when
 * playback's loading changes, the network, the liked list or Download using mobile data
 * changes, the cache is cleared, a back-off ends or a save finishes. Its one timer ([recheck]) is a one-shot postDelayed for the
 * end of the gap between two extractions (pending only while the gap alone holds back a save
 * that could start) or for the retry of a save that stopped ([SaveStrikes]), whichever is
 * sooner; cancelled by the next check and by [stop]. Downloads run on the one
 * background thread ([Background]), one at a time, through a [CacheWriter] (only the bytes not
 * yet saved are fetched), and give way at once when playback needs the network ([giveWay],
 * [PlaybackNeed]). A song too big for the room left on the phone stops as soon as its size is
 * known ([LikedSaverPolicy.tooBig]).
 *
 * Main thread, except [SaveJob.run].
 */
@OptIn(UnstableApi::class)
internal class LikedSaver(private val handler: Handler, private val host: Host) {
    interface Host {
        /** The songs (audio ids) the player loads anyway (the playing track and the next). */
        fun loadingPair(): Set<String>

        /** Of those, the ones it is still loading ([PlaybackNeed.stillLoading]): left to it meanwhile. */
        fun stillLoading(): Set<String>

        /** Playback needs the network now ([PlaybackNeed]). */
        fun playbackNeedsNetwork(): Boolean
    }

    private var online = false
    private var unmetered = false

    /** The system blocks the app's network though it is up (onBlockedStatusChanged, API 29+). */
    private var blocked = false
    private var stopped = false

    /** Liked just now this session: saved first. */
    private val fresh = HashSet<String>()

    /** Fresh ones already tried once: their retries wait for the gap. */
    private val tried = HashSet<String>()

    /** Couldn't be saved this service's life (unavailable, refused); stopped too often is [strikes]'. */
    private val failed = HashSet<String>()

    /** Saves that stopped: each waits longer before its next try, then is given up on. */
    private val strikes = SaveStrikes()

    /** When the last save extracted (elapsedRealtime); 0 = none yet. */
    private var lastExtractionAt = 0L

    private var job: SaveJob? = null

    /** Covers ([ArtStore]): one fetch at a time; [artDone] until the saved or liked songs change. */
    private var artBusy = false
    private var artDone = false

    /** Songs whose covers couldn't be fetched this service's life: not tried again. */
    private val artFailed = HashSet<String>()

    private val recheck = Runnable { check() }

    /** The cache's saved set changed, or it was cleared (any thread). */
    val cacheListener = object : AudioCache.Listener {
        override fun onSavedChanged() {
            handler.post {
                artDone = false
                check()
            }
        }

        override fun onCleared() {
            handler.post { cleared() }
        }

        override fun onMobileDataChanged() {
            handler.post { check() }
        }
    }

    val likedListener = AudioCache.LikedListener { freshIds ->
        handler.post {
            fresh.addAll(freshIds)
            val liked = AudioCache.liked.toSet()
            fresh.retainAll(liked)
            tried.retainAll(liked)
            artDone = false
            check()
        }
    }

    /** The default network: [validated] (online) and [unmetered] (Wi-Fi). Only a change counts. */
    fun onNetwork(validated: Boolean, unmetered: Boolean) {
        if (validated == online && unmetered == this.unmetered) return
        // Back online, or onto another kind of network: the stops so far start afresh.
        if (validated) strikes.clear()
        online = validated
        this.unmetered = unmetered
        check()
    }

    /**
     * The app's network is [blocked] (or no longer is) by the system while the network itself is
     * up: saves wait, as Media3's RequirementsWatcher has them do, instead of failing into strikes;
     * unblocked, the songs that stopped meanwhile start afresh.
     */
    fun onBlocked(blocked: Boolean) {
        if (blocked == this.blocked) return
        this.blocked = blocked
        if (!blocked) strikes.clear()
        check()
    }

    /** Something the policy depends on changed: start a save, or stop the running one. */
    fun check() {
        handler.removeCallbacks(recheck)
        if (stopped) return
        val f = facts()
        job?.let { running ->
            // Playback needs the network, Wi-Fi left (with Download using mobile data off), or the
            // song became members-only while signed out.
            if (!LikedSaverPolicy.keepGoing(f, CacheKeys.isMp3(running.audioId), copy = running.audioId in f.copyable) || AudioCache.isDenied(running.audioId)) {
                running.cancel()
            }
            return
        }
        val audioId = LikedSaverPolicy.next(f)
        if (audioId == null) {
            // Held back by the gap alone: one re-check when it ends (no other event may come).
            LikedSaverPolicy.recheckInMs(f)?.let { handler.postDelayed(recheck, it) }
            fetchArt(f)
            return
        }
        start(audioId, audioId in fresh, copy = audioId in f.copyable)
    }

    /**
     * Nothing to save now: the covers of saved songs that have none on the phone yet are fetched,
     * one song at a time, on the networks a save may use, and those of songs no longer liked go.
     * On [Background], as the files are there (a few small images; not a save, so no gap).
     */
    private fun fetchArt(f: LikedSaverPolicy.Facts) {
        val files = ArtStore.files ?: return
        if (artBusy || artDone || !LikedSaverPolicy.mayDownload(f)) return
        artBusy = true
        val saved = f.saved.toList()
        val liked = f.liked.toHashSet()
        val skip = HashSet(artFailed)
        Background.run("Liked art") {
            var next: String? = null
            var ok = true
            try {
                // Only with the liked list known: an empty one (not read yet) would take every cover.
                if (liked.isNotEmpty()) files.keepOnly(liked)
                next = saved.firstOrNull { it !in skip && files.missing(it).isNotEmpty() }
                next?.let { id -> ok = files.missing(id).all { files.fetch(it, Http.client) } }
            } catch (e: IOException) {
                ok = false
                Log.w(TAG, "Liked art failed: ${e.javaClass.simpleName}")
            } finally {
                val id = next
                handler.post {
                    artBusy = false
                    if (id == null) artDone = true else if (!ok) artFailed.add(id)
                    check()
                }
            }
        }
    }

    /** Playback needs the network (or the prefetch thread): the running save stops at once. */
    fun giveWay() {
        job?.cancel()
    }

    /**
     * Clear cache (the listening cache only): the liked songs playing and next count as liked
     * just now ([LikedSaverPolicy.freshAfterClear]), so those not in the saved store are saved
     * first, once they're no longer playing or next.
     */
    private fun cleared() {
        val again = LikedSaverPolicy.freshAfterClear(AudioCache.liked, host.loadingPair())
        fresh.addAll(again)
        tried.removeAll(again)
        check()
    }

    /** The service is going: nothing more starts, the running save stops, no re-check is left. */
    fun stop() {
        stopped = true
        handler.removeCallbacks(recheck)
        job?.cancel()
    }

    private fun facts(): LikedSaverPolicy.Facts {
        val liked = AudioCache.liked
        val now = SystemClock.elapsedRealtime()
        return LikedSaverPolicy.Facts(
            liked = liked,
            saved = AudioCache.inStore,
            copyable = AudioCache.copyable,
            playing = host.loadingPair(),
            fresh = fresh,
            tried = tried,
            skip = host.stillLoading() + failed + strikes.givenUp() + strikes.waiting(now),
            // Online, and not blocked for the app (Doze, Battery Saver, data saver in the background).
            online = online && !blocked,
            unmetered = unmetered,
            mobileDataAllowed = AudioCache.downloadOnMobileData,
            quiet = NetBlock.isQuiet(),
            playbackNeedsNetwork = host.playbackNeedsNetwork(),
            busy = job != null,
            lowSpace = AudioCache.freeBytes() < LikedSaverPolicy.FREE_FLOOR_BYTES,
            sinceLastMs = if (lastExtractionAt == 0L) Long.MAX_VALUE else now - lastExtractionAt,
            retryInMs = strikes.nextDueInMs(now),
            denied = AudioCache::isDenied,
            cache = !AudioCache.startFailed && !AudioCache.savedFailed,
        )
    }

    private fun start(audioId: String, isFresh: Boolean, copy: Boolean) {
        // An MP3's download counts like an extraction: the backfill stays spaced out either way.
        // A copy from the listening cache asks nothing of the network.
        if (!copy) lastExtractionAt = SystemClock.elapsedRealtime()
        if (isFresh) tried.add(audioId)
        val j = SaveJob(audioId, SaveJob.Live(), copy)
        job = j
        // Set before it is queued: upkeep arriving before it runs still stops it.
        AudioCache.cancelSave = { j.cancel() }
        Background.run("Liked save") {
            var outcome = SaveOutcome.STOPPED
            try {
                outcome = j.run()
            } catch (e: Exception) {
                Log.w(TAG, "Liked save failed: ${e.javaClass.simpleName}")
            } finally {
                // Always back on the main thread, whatever happened: the saver is never stuck busy.
                handler.post { finished(j, outcome) }
            }
        }
    }

    private fun finished(j: SaveJob, outcome: SaveOutcome) {
        if (job === j) {
            job = null
            AudioCache.cancelSave = null
        }
        // No id: R8 keeps info logs out of release builds, and this needs none.
        when (outcome) {
            SaveOutcome.SAVED -> {
                Log.i(TAG, "Liked song saved")
                fresh.remove(j.audioId)
                tried.remove(j.audioId)
                strikes.forget(j.audioId)
            }
            SaveOutcome.FAILED -> {
                Log.w(TAG, "Liked save refused or impossible")
                failed.add(j.audioId)
            }
            // Not cancelled, yet not saved (a dropped connection, an exception): tried again after
            // a wait that doubles each time, and given up on after the fifth stop, so a song that
            // can't be saved isn't tried forever, nor hammered while the connection is bad.
            SaveOutcome.STOPPED -> {
                Log.i(TAG, "Liked save stopped")
                strikes.stopped(j.audioId, SystemClock.elapsedRealtime())
            }
            SaveOutcome.CANCELLED -> Unit
        }
        check()
    }

    /**
     * One song into the saved store: copied from a whole listening copy (no network), else the
     * extraction at the save quality ([QualityLadder.saveRung]), then its bytes through a
     * [Writer]; a Jukebox MP3 ([audioId] `mp3:<file>`) has no extraction, only its file's bytes.
     * Cancelled from any thread; runs on [Background]'s thread. The world it needs comes
     * through [Deps] ([Live] in the app), so the outcome table is a JVM test (SaveJobTest).
     * Stops once the song's size says it doesn't fit ([LikedSaverPolicy.tooBig]).
     */
    internal class SaveJob(val audioId: String, private val deps: Deps, private val copy: Boolean = false) {
        /** A Jukebox MP3: no extraction, and YouTube's back-off is none of its business. */
        private val mp3 = CacheKeys.isMp3(audioId)

        /** What a save needs from the back-off, the cache and the resolver. */
        interface Deps {
            /** A back-off is in force, or nothing has succeeded since one: no extraction now. */
            fun quiet(): Boolean

            /** Members-only while signed out: not cached. */
            fun isDenied(audioId: String): Boolean

            /** Saved whole in the saved store. */
            fun isWhole(audioId: String): Boolean

            /** The key of [audioId]'s whole copy in the listening cache, or null. */
            fun listeningCopy(audioId: String): String? = null

            /** An extraction ([StreamResolver.resolve]): a [ResolveException], a [ManifestOnlyException] or another IOException. */
            @Throws(IOException::class)
            fun resolve(ytId: String): ResolvedStream

            /** Whether there is a cache to save into. */
            fun hasCache(): Boolean = true

            /** What saves may fill now ([LikedSaverPolicy.roomFor] the free space), in bytes. */
            fun roomBytes(): Long

            /** Removes [audioId]'s audio from the phone (a song too big to keep). */
            fun discard(audioId: String)

            /** A writer fetching [stream]'s bytes not yet saved into the saved store, or null without one. */
            @Throws(IOException::class)
            fun writer(ytId: String, stream: ResolvedStream, progress: Progress): Writer?

            /** A writer fetching a Jukebox MP3's bytes not yet cached from latex.gg, or null without a cache. */
            @Throws(IOException::class)
            fun mp3Writer(audioId: String, progress: Progress): Writer?

            /** A writer copying [audioId]'s listening copy [key] into the saved store (never the network), or null without both. */
            @Throws(IOException::class)
            fun copyWriter(audioId: String, key: String, progress: Progress): Writer?

            /** The HTTP status [e], from a writer, carries; null for none ([SaveRefusal] reads it). */
            fun httpCode(e: IOException): Int?

            /** [ytId]'s link was refused: the next extraction gets a fresh one ([StreamResolver.reResolve]). */
            fun forgetLink(ytId: String)
        }

        /**
         * A writer's progress, on its thread (CacheWriter.ProgressListener): the song's [length]
         * (-1 until known: the response didn't say) and its bytes saved so far ([cached]).
         */
        fun interface Progress {
            fun onProgress(length: Long, cached: Long)
        }

        /** The write of one song's bytes (a [CacheWriter]); cancelled from any thread. */
        interface Writer {
            @Throws(IOException::class)
            fun cache()

            fun cancel()
        }

        /** The app's: [NetBlock], [AudioCache], [StreamResolver] and a [CacheWriter]. */
        class Live : Deps {
            override fun quiet() = NetBlock.isQuiet()

            override fun isDenied(audioId: String) = AudioCache.isDenied(audioId)

            override fun isWhole(audioId: String) = AudioCache.isStored(audioId)

            override fun listeningCopy(audioId: String) = AudioCache.listeningCopy(audioId)

            override fun hasCache() = AudioCache.open() != null && AudioCache.savedStore != null

            override fun roomBytes() = LikedSaverPolicy.roomFor(AudioCache.freeBytes())

            override fun discard(audioId: String) = AudioCache.discard(audioId)

            // An extraction, like playing it would be (it counts toward YouTube's limits, hence
            // one at a time and spaced out); a back-off stops it (BlockedException). At the save
            // quality, not Auto's rung of the moment.
            override fun resolve(ytId: String): ResolvedStream =
                StreamResolver.resolve(ytId, rung = QualityLadder.saveRung(StreamResolver.quality))

            override fun writer(ytId: String, stream: ResolvedStream, progress: Progress): Writer? =
                writerOf(YtDataSpecResolver.streamSpec(DataSpec.Builder().setUri(JukeUris.forYt(ytId)).build(), ytId, stream), progress)

            // The same writer, with the request playback would make: the latex.gg link rebuilt
            // from the file name, and its key (mp3Spec).
            override fun mp3Writer(audioId: String, progress: Progress): Writer? {
                val url = SessionPolicy.mp3UrlForFile(SessionPolicy.mp3FileOfAudioId(audioId)) ?: throw IOException("Not a Jukebox MP3")
                return writerOf(YtDataSpecResolver.mp3Spec(DataSpec.Builder().setUri(url).build(), url), progress)
            }

            // Our own URI: a byte the listening copy lost fails the copy at once (CacheMissGuard),
            // never a request.
            override fun copyWriter(audioId: String, key: String, progress: Progress): Writer? {
                val uri = SessionPolicy.mp3FileOfAudioId(audioId)?.let { JukeUris.forMp3File(it) } ?: JukeUris.forYt(audioId)
                return writerOf(DataSpec.Builder().setUri(uri).setKey(key).build(), progress)
            }

            /** A [CacheWriter] of [spec] into the saved store ([AudioCache.saveSource]), or null without one. */
            private fun writerOf(spec: DataSpec, progress: Progress): Writer? {
                val source = AudioCache.saveSource() ?: return null
                val w = CacheWriter(source, spec, null) { length, cached, _ -> progress.onProgress(length, cached) }
                return object : Writer {
                    override fun cache() = w.cache()

                    override fun cancel() = w.cancel()
                }
            }

            override fun httpCode(e: IOException) = e.findCause<HttpDataSource.InvalidResponseCodeException>()?.responseCode

            override fun forgetLink(ytId: String) = StreamResolver.reResolve(ytId)
        }

        @Volatile
        private var cancelled = false

        @Volatile
        private var writer: Writer? = null

        /** The song's size said it doesn't fit ([LikedSaverPolicy.tooBig]); set on the job's thread. */
        private var tooBig = false

        /** The room at the save's start (the free space shrinks as it writes). */
        private val room by lazy { deps.roomBytes() }

        fun cancel() {
            cancelled = true
            writer?.cancel()
        }

        /**
         * The writer's progress: once the song's length (or, unknown, what has come so far) is
         * too big, the writer stops. A known length is told when the request opens, before any
         * of its bytes are read.
         */
        private val progress = Progress { length, cached ->
            // A copy is already on the phone, and the saved store has no size limit.
            if (!tooBig && !copying) {
                tooBig = LikedSaverPolicy.tooBig(if (length > 0) length else cached, room)
                if (tooBig) writer?.cancel()
            }
        }

        /**
         * A save its size stopped: one too big for the room left is given up on, and what it has
         * on the phone goes. Null: no such stop.
         */
        private fun sizeOutcome(): SaveOutcome? = if (tooBig) SaveOutcome.FAILED.also { deps.discard(audioId) } else null

        /** A YouTube back-off is in force: it holds a video's download, never an MP3's or a copy's. */
        private fun quiet() = !mp3 && !copying && deps.quiet()

        /** Copying a listening copy (set on the job's thread before the write). */
        private var copying = false

        fun run(): SaveOutcome {
            // Cancelled, or members-only while signed out: no fault of the song.
            if (cancelled || deps.isDenied(audioId)) return SaveOutcome.CANCELLED
            if (deps.isWhole(audioId)) return SaveOutcome.SAVED
            // Before the extraction: without a cache (it failed to start just now) there is
            // nothing to save into, and the saver stops ([LikedSaverPolicy.Facts.cache]).
            if (!deps.hasCache()) return SaveOutcome.STOPPED
            // Whole in the listening cache (played, or saved before 1.3.6): copied as it is, any
            // quality, with no request, so a back-off doesn't hold it.
            deps.listeningCopy(audioId)?.let { key ->
                copying = true
                return write { deps.copyWriter(audioId, key, progress) }
            }
            // Picked to copy, but the listening copy went meanwhile: a strike, never a download
            // the policy didn't allow (the network, the gap).
            if (copy) return SaveOutcome.STOPPED
            // A back-off: no fault of the song either.
            if (quiet()) return SaveOutcome.CANCELLED
            // A Jukebox MP3: no extraction, no format to check; its file's bytes, as below.
            if (mp3) return write { deps.mp3Writer(audioId, progress) }
            val stream = try {
                deps.resolve(audioId)
            } catch (e: ResolveException) {
                return when (SaveFailure.of(e.kind)) {
                    SaveFailure.GIVE_UP -> SaveOutcome.FAILED
                    SaveFailure.STRIKE -> if (cancelled) SaveOutcome.CANCELLED else SaveOutcome.STOPPED
                    SaveFailure.WAIT -> SaveOutcome.CANCELLED
                }
            } catch (e: ManifestOnlyException) {
                return SaveOutcome.FAILED
            } catch (e: IOException) {
                // A back-off (BlockedException) is no strike either.
                return if (cancelled || quiet()) SaveOutcome.CANCELLED else SaveOutcome.STOPPED
            }
            // Only an audio-only format is kept.
            if (!stream.audioOnly || stream.itag <= 0) return SaveOutcome.FAILED
            if (cancelled) return SaveOutcome.CANCELLED
            return write { deps.writer(audioId, stream, progress) }
        }

        /** The song's bytes not yet cached, through the writer [make] gives (null: no cache). */
        private fun write(make: () -> Writer?): SaveOutcome {
            return try {
                val w = make() ?: return SaveOutcome.STOPPED
                writer = w
                if (cancelled) return SaveOutcome.CANCELLED
                w.cache()
                // A length learned only at the end may still be too big; else saved only if it
                // is whole now ([SaveOutcome.afterWrite]).
                sizeOutcome() ?: SaveOutcome.afterWrite(deps.isWhole(audioId))
            } catch (e: IOException) {
                val code = deps.httpCode(e)
                if (SaveRefusal.staleLink(code, mp3)) deps.forgetLink(audioId)
                sizeOutcome() ?: when {
                    cancelled || quiet() -> SaveOutcome.CANCELLED
                    SaveRefusal.refused(code, mp3) -> SaveOutcome.FAILED
                    else -> SaveOutcome.STOPPED
                }
            } finally {
                writer = null
            }
        }
    }

    private companion object {
        const val TAG = "CyberJukeSaver"
    }
}
