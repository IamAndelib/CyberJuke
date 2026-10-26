package io.github.iamandelib.cyberjuke.playback

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.FileDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import io.github.iamandelib.cyberjuke.findCause
import io.github.iamandelib.cyberjuke.net.BlockedException
import java.io.FileNotFoundException

/**
 * Don't keep retrying what can never succeed or would make things worse: unavailable videos,
 * bot checks, a running back-off, and HTTP 403/410/429 (429 must never be retried; 403/410 are
 * handled by re-resolving in PlaybackService). Everything else is retried [LoadRetry.NETWORK_RETRIES]
 * times before the player hears of it, while the buffer keeps playing; a network failure with a
 * capped back-off ([LoadRetry]), the rest with the default delays.
 */
@OptIn(UnstableApi::class)
internal class JukeLoadErrorPolicy : DefaultLoadErrorHandlingPolicy() {
    override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long {
        val e = loadErrorInfo.exception
        val ytId = JukeUris.ytIdOf(loadErrorInfo.loadEventInfo.dataSpec.uri)
        val facts = Facts(
            httpCode = e.findCause<HttpDataSource.InvalidResponseCodeException>()?.responseCode,
            httpTransport = e.findCause<HttpDataSource.HttpDataSourceException>() != null,
            ytLoad = ytId != null,
            mp3Load = JukeUris.mp3UrlOf(loadErrorInfo.loadEventInfo.dataSpec.uri) != null,
            fileError = e.findCause<FileDataSource.FileDataSourceException>() != null,
            errorCount = loadErrorInfo.errorCount,
            default = super.getRetryDelayMsFor(loadErrorInfo),
        )
        val delay = delayFor(e, facts)
        // The cache's file is skipped for a moment, so the retry fetches from the network.
        if (delay == LoadRetry.CACHE_RETRY_MS && ytId != null) AudioCache.misses.missed(ytId)
        return delay
    }

    /** The error reaches the player only after this many retries (and once it needs the data). */
    override fun getMinimumLoadableRetryCount(dataType: Int): Int =
        maxOf(super.getMinimumLoadableRetryCount(dataType), LoadRetry.NETWORK_RETRIES)

    /** What the rule looks at besides the error's own causes. */
    data class Facts(
        /** An HTTP status among the causes (InvalidResponseCodeException). */
        val httpCode: Int? = null,
        /** An HTTP data source failure without a status: the transport broke. */
        val httpTransport: Boolean = false,
        /** A load of a YouTube track (a cyberjuke://yt/ URI), not a manifest or an asset. */
        val ytLoad: Boolean = false,
        /** A load of a Jukebox MP3 (a cyberjuke://mp3/ URI): a 4xx is the file's (gone, private), never retried. */
        val mp3Load: Boolean = false,
        /** A listening-cache file couldn't be read (FileDataSourceException; a missing file shows in the error itself). */
        val fileError: Boolean = false,
        /** The [errorCount]th error in a row, from 1. */
        val errorCount: Int = 1,
        /** What Media3's default policy says for this error (TIME_UNSET: never retried). */
        val default: Long = 0L,
    )

    companion object {
        val NO_RETRY_HTTP = setOf(403, 410, 429)

        /**
         * The wait before retrying [e], or C.TIME_UNSET for never. Pure (JukeLoadErrorPolicyTest):
         * the one place that decides; getRetryDelayMsFor only gathers the [Facts].
         */
        fun delayFor(e: Throwable, f: Facts): Long {
            if (e.findCause<ManifestOnlyException>() != null) return C.TIME_UNSET
            if (e.findCause<BlockedException>() != null) return C.TIME_UNSET
            val resolve = e.findCause<ResolveException>()
            if (resolve != null && resolve.permanent) return C.TIME_UNSET
            if (f.httpCode != null && f.httpCode in NO_RETRY_HTTP) return C.TIME_UNSET
            if (f.mp3Load && f.httpCode != null && f.httpCode in 400..499) return C.TIME_UNSET
            // A listening-cache file gone (low storage) or unreadable: the retry fetches the bytes
            // from the network, not from the cache (the video is skipped there for a moment); the
            // default never retries a missing file: a dead track.
            LoadRetry.cacheFileRetryMs(
                ytLoad = f.ytLoad,
                fileError = f.fileError || e.findCause<FileNotFoundException>() != null,
            )?.let { return it }
            // What the default never retries (a malformed file, a missing one) stays that way.
            if (f.default == C.TIME_UNSET) return C.TIME_UNSET
            // A broken connection, or the resolver not reaching YouTube (a new network), waits
            // with the capped back-off; anything else with the default delays. Never given up on
            // here: the minimum retry count decides when it reaches the player.
            val network = LoadRetry.isNetwork(
                httpStatus = f.httpCode != null,
                resolverNetwork = resolve != null, // a permanent one returned above
                httpTransport = f.httpTransport,
                transportCause = LoadRetry.hasTransportCause(e),
            )
            return LoadRetry.retryDelayMs(f.errorCount, network)
        }
    }
}
