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
 * playing): no job, no alarm, nothing that wakes the phone. Event-driven, never on a timer:
 * asked again when the player stops loading, the network or the liked list changes, a back-off
 * ends or a save finishes. Downloads run on the one background thread ([Background]), one at a
 * time, through a [CacheWriter] (only the bytes not yet cached are fetched), and give way at
 * once when playback needs the network ([giveWay]).
 *
 * Main thread, except [SaveJob.run].
 */
@OptIn(UnstableApi::class)
internal class LikedSaver(private val handler: Handler, private val host: Host) {
    interface Host {
        /** The videos the player loads anyway (the playing track and the next). */
        fun loadingPair(): Set<String>

        /** The player is loading (playback needs the network now). */
        fun playerLoading(): Boolean
    }

    private var online = false
    private var unmetered = false
    private var stopped = false

    /** Liked this session: saved on any network. */
    private val fresh = HashSet<String>()

    /** Couldn't be saved this session (unavailable, no audio-only format, refused). */
    private val failed = HashSet<String>()

    /** When the last save extracted (elapsedRealtime); 0 = none yet. */
    private var lastExtractionAt = 0L

    private var job: SaveJob? = null

    /** The cache's liked list or saved set changed (any thread). */
    val cacheListener = AudioCache.Listener { handler.post { check() } }

    val likedListener = AudioCache.LikedListener { freshIds ->
        handler.post {
            fresh.addAll(freshIds)
            fresh.retainAll(AudioCache.liked.toSet())
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
        if (stopped) return
        val f = facts()
        job?.let { running ->
            if (!LikedSaverPolicy.keepGoing(f, running.fresh)) running.cancel()
            return
        }
        val ytId = LikedSaverPolicy.next(f) ?: return
        start(ytId, ytId in fresh)
    }

    /** Playback needs the network (or the prefetch thread): the running save stops at once. */
    fun giveWay() {
        job?.cancel()
    }

    /** The service is going: nothing more starts, the running save stops. */
    fun stop() {
        stopped = true
        job?.cancel()
    }

    private fun facts() = LikedSaverPolicy.Facts(
        liked = AudioCache.liked,
        saved = AudioCache.savedLiked,
        fresh = fresh,
        skip = host.loadingPair() + failed,
        online = online,
        unmetered = unmetered,
        quiet = NetBlock.isQuiet(),
        playerLoading = host.playerLoading(),
        busy = job != null,
        likedFull = AudioCache.likedFull,
        sinceLastMs = if (lastExtractionAt == 0L) Long.MAX_VALUE else SystemClock.elapsedRealtime() - lastExtractionAt,
    )

    private fun start(ytId: String, isFresh: Boolean) {
        lastExtractionAt = SystemClock.elapsedRealtime()
        val j = SaveJob(ytId, isFresh)
        job = j
        Background.run("Liked save") {
            val outcome = j.run()
            handler.post { finished(j, outcome) }
        }
    }

    private fun finished(j: SaveJob, outcome: Outcome) {
        if (job === j) job = null
        when (outcome) {
            Outcome.SAVED -> fresh.remove(j.ytId)
            Outcome.FAILED -> failed.add(j.ytId)
            Outcome.STOPPED -> Unit
        }
        check()
    }

    private enum class Outcome { SAVED, FAILED, STOPPED }

    /** One song into the cache. Cancelled from the main thread; runs on [Background]'s thread. */
    private class SaveJob(val ytId: String, val fresh: Boolean) {
        @Volatile
        private var cancelled = false

        @Volatile
        private var writer: CacheWriter? = null

        fun cancel() {
            cancelled = true
            writer?.cancel()
        }

        fun run(): Outcome {
            if (cancelled || NetBlock.isQuiet()) return Outcome.STOPPED
            if (AudioCache.isWhole(ytId)) return Outcome.SAVED
            val stream = try {
                // An extraction, like playing it would be (it counts toward YouTube's limits,
                // hence one at a time and spaced out); a back-off stops it (BlockedException).
                StreamResolver.resolve(ytId)
            } catch (e: ResolveException) {
                return if (e.permanent) Outcome.FAILED else Outcome.STOPPED
            } catch (e: ManifestOnlyException) {
                return Outcome.FAILED
            } catch (e: IOException) {
                return Outcome.STOPPED
            }
            // Only an audio-only format is kept in the cache.
            if (!stream.audioOnly || stream.itag <= 0) return Outcome.FAILED
            if (cancelled) return Outcome.STOPPED
            val source = AudioCache.downloadSource() ?: return Outcome.STOPPED
            return try {
                val spec = YtDataSpecResolver.streamSpec(DataSpec.Builder().setUri(JukeUris.forYt(ytId)).build(), ytId, stream)
                val w = CacheWriter(source, spec, null, null)
                writer = w
                if (cancelled) return Outcome.STOPPED
                w.cache()
                Log.i(TAG, "Saved $ytId")
                Outcome.SAVED
            } catch (e: IOException) {
                // Refused (an expired link, a block): not again this session. Anything else
                // (cancelled, the connection) tries again later.
                if (!cancelled && e.findCause<HttpDataSource.InvalidResponseCodeException>() != null) {
                    Log.w(TAG, "Liked save refused")
                    Outcome.FAILED
                } else {
                    Outcome.STOPPED
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
