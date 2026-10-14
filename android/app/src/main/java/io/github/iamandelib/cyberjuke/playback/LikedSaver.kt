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
import io.github.iamandelib.cyberjuke.net.NetBlock
import java.io.IOException

/**
 * Saves liked songs into the listening cache, so they play offline ([LikedSaverPolicy] decides
 * when and which). A song liked while online is saved at once (usually it is already, having
 * just played); older likes are filled in one at a time, newest first, on Wi-Fi only.
 *
 * Lives in PlaybackService, so it only runs while the service already does (the app is open or
 * playing): no job, no alarm, nothing that wakes the phone. Event-driven: asked again when
 * playback's loading changes, the network or the liked list changes, the cache is cleared, a
 * back-off ends or a save finishes. Its one timer ([recheck]) is a one-shot postDelayed for the
 * end of the gap between two extractions (pending only while the gap alone holds back a save
 * that could start) or for the retry of a save that stopped ([SaveStrikes]), whichever is
 * sooner; cancelled by the next check and by [stop]. Downloads run on the one
 * background thread ([Background]), one at a time, through a [CacheWriter] (only the bytes not
 * yet cached are fetched), and give way at once when playback needs the network ([giveWay],
 * [PlaybackNeed]).
 *
 * Main thread, except [SaveJob.run].
 */
@OptIn(UnstableApi::class)
internal class LikedSaver(private val handler: Handler, private val host: Host) {
    interface Host {
        /** The videos the player loads anyway (the playing track and the next). */
        fun loadingPair(): Set<String>

        /** Of those, the ones it is still loading ([PlaybackNeed.stillLoading]): left to it meanwhile. */
        fun stillLoading(): Set<String>

        /** Playback needs the network now ([PlaybackNeed]). */
        fun playbackNeedsNetwork(): Boolean
    }

    private var online = false
    private var unmetered = false
    private var stopped = false

    /** Liked just now this session: saved on any network. */
    private val fresh = HashSet<String>()

    /** Fresh ones already tried once: their retries wait for the gap. */
    private val tried = HashSet<String>()

    /** Couldn't be saved this service's life (unavailable, refused, stopped [SaveStrikes.MAX] times). */
    private val failed = HashSet<String>()

    /** Saves that stopped: each waits longer before its next try, then is given up on. */
    private val strikes = SaveStrikes()

    /** When the last save extracted (elapsedRealtime); 0 = none yet. */
    private var lastExtractionAt = 0L

    private var job: SaveJob? = null

    private val recheck = Runnable { check() }

    /** The cache's saved set changed, or it was cleared (any thread). */
    val cacheListener = object : AudioCache.Listener {
        override fun onSavedChanged() {
            handler.post { check() }
        }

        override fun onCleared() {
            handler.post { cleared() }
        }
    }

    val likedListener = AudioCache.LikedListener { freshIds ->
        handler.post {
            fresh.addAll(freshIds)
            val liked = AudioCache.liked.toSet()
            fresh.retainAll(liked)
            tried.retainAll(liked)
            check()
        }
    }

    /** The default network: [validated] (online) and [unmetered] (Wi-Fi). Only a change counts. */
    fun onNetwork(validated: Boolean, unmetered: Boolean) {
        if (validated == online && unmetered == this.unmetered) return
        online = validated
        this.unmetered = unmetered
        check()
    }

    /** Something the policy depends on changed: start a save, or stop the running one. */
    fun check() {
        handler.removeCallbacks(recheck)
        if (stopped) return
        val f = facts()
        job?.let { running ->
            // Playback needs the network, or the song became members-only while signed out.
            if (!LikedSaverPolicy.keepGoing(f, running.fresh) || AudioCache.isDenied(running.ytId)) running.cancel()
            return
        }
        val ytId = LikedSaverPolicy.next(f)
        if (ytId == null) {
            // Held back by the gap alone: one re-check when it ends (no other event may come).
            LikedSaverPolicy.recheckInMs(f)?.let { handler.postDelayed(recheck, it) }
            return
        }
        start(ytId, ytId in fresh)
    }

    /** Playback needs the network (or the prefetch thread): the running save stops at once. */
    fun giveWay() {
        job?.cancel()
    }

    /**
     * Clear cache: the liked songs playing and next count as liked just now
     * ([LikedSaverPolicy.freshAfterClear]), so they are saved again, on any network, once the
     * player has loaded them.
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
            saved = AudioCache.savedLiked,
            fresh = fresh,
            tried = tried,
            skip = host.stillLoading() + failed + strikes.waiting(now),
            online = online,
            unmetered = unmetered,
            quiet = NetBlock.isQuiet(),
            playbackNeedsNetwork = host.playbackNeedsNetwork(),
            busy = job != null,
            likedFull = AudioCache.likedFull,
            sinceLastMs = if (lastExtractionAt == 0L) Long.MAX_VALUE else now - lastExtractionAt,
            retryInMs = strikes.nextDueInMs(now),
            denied = AudioCache::isDenied,
        )
    }

    private fun start(ytId: String, isFresh: Boolean) {
        lastExtractionAt = SystemClock.elapsedRealtime()
        if (isFresh) tried.add(ytId)
        val j = SaveJob(ytId, isFresh)
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
        when (outcome) {
            SaveOutcome.SAVED -> {
                fresh.remove(j.ytId)
                tried.remove(j.ytId)
                strikes.forget(j.ytId)
            }
            SaveOutcome.FAILED -> failed.add(j.ytId)
            // Not cancelled, yet not saved (a dropped connection, an exception): tried again after
            // a wait that doubles each time, and given up on after the fifth stop, so a song that
            // can't be saved isn't tried forever, nor hammered while the connection is bad.
            SaveOutcome.STOPPED -> if (strikes.stopped(j.ytId, SystemClock.elapsedRealtime())) failed.add(j.ytId)
            SaveOutcome.CANCELLED -> Unit
        }
        check()
    }

    /** One song into the cache. Cancelled from any thread; runs on [Background]'s thread. */
    private class SaveJob(val ytId: String, val fresh: Boolean) {
        @Volatile
        private var cancelled = false

        @Volatile
        private var writer: CacheWriter? = null

        fun cancel() {
            cancelled = true
            writer?.cancel()
        }

        fun run(): SaveOutcome {
            // Cancelled, a back-off, or members-only while signed out: no fault of the song.
            if (cancelled || NetBlock.isQuiet() || AudioCache.isDenied(ytId)) return SaveOutcome.CANCELLED
            if (AudioCache.isWhole(ytId)) return SaveOutcome.SAVED
            val stream = try {
                // An extraction, like playing it would be (it counts toward YouTube's limits,
                // hence one at a time and spaced out); a back-off stops it (BlockedException).
                StreamResolver.resolve(ytId)
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
                return if (cancelled || NetBlock.isQuiet()) SaveOutcome.CANCELLED else SaveOutcome.STOPPED
            }
            // Only an audio-only format is kept in the cache.
            if (!stream.audioOnly || stream.itag <= 0) return SaveOutcome.FAILED
            if (cancelled) return SaveOutcome.CANCELLED
            val source = AudioCache.downloadSource() ?: return SaveOutcome.STOPPED
            return try {
                val spec = YtDataSpecResolver.streamSpec(DataSpec.Builder().setUri(JukeUris.forYt(ytId)).build(), ytId, stream)
                val w = CacheWriter(source, spec, null, null)
                writer = w
                if (cancelled) return SaveOutcome.CANCELLED
                w.cache()
                // Saved only if it is whole now ([SaveOutcome.afterWrite]). No id: R8 keeps info
                // logs out of release builds, and this needs none.
                SaveOutcome.afterWrite(AudioCache.isWhole(ytId)).also {
                    Log.i(TAG, if (it == SaveOutcome.SAVED) "Liked song saved" else "Liked song not whole after its save")
                }
            } catch (e: IOException) {
                when {
                    cancelled || NetBlock.isQuiet() -> SaveOutcome.CANCELLED
                    // Refused (an expired link, a block): not again this service's life.
                    e.findCause<HttpDataSource.InvalidResponseCodeException>() != null -> {
                        Log.w(TAG, "Liked save refused")
                        SaveOutcome.FAILED
                    }
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
