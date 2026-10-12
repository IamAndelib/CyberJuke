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
        if (e.findCause<ManifestOnlyException>() != null) return C.TIME_UNSET
        if (e.findCause<BlockedException>() != null) return C.TIME_UNSET
        val resolve = e.findCause<ResolveException>()
        if (resolve != null && resolve.permanent) return C.TIME_UNSET
        val http = e.findCause<HttpDataSource.InvalidResponseCodeException>()
        if (http != null && http.responseCode in NO_RETRY_HTTP) return C.TIME_UNSET
        // A listening-cache file gone (low storage) or broken: the cache drops it, the retry
        // fetches the bytes (the default never retries a missing file: a dead track).
        LoadRetry.cacheFileRetryMs(
            ytLoad = JukeUris.ytIdOf(loadErrorInfo.loadEventInfo.dataSpec.uri) != null,
            fileError = e.findCause<FileNotFoundException>() != null || e.findCause<FileDataSource.FileDataSourceException>() != null,
        )?.let { return it }
        // What the default never retries (a malformed file, a missing one) stays that way.
        if (super.getRetryDelayMsFor(loadErrorInfo) == C.TIME_UNSET) return C.TIME_UNSET
        // A broken connection, or the resolver not reaching YouTube (a new network), waits
        // with the capped back-off; anything else with the default delays. Never given up on
        // here: the minimum retry count decides when it reaches the player.
        val network = LoadRetry.isNetwork(
            httpStatus = http != null,
            resolverNetwork = resolve != null, // a permanent one returned above
            httpTransport = e.findCause<HttpDataSource.HttpDataSourceException>() != null,
            transportCause = LoadRetry.hasTransportCause(e),
        )
        return LoadRetry.retryDelayMs(loadErrorInfo.errorCount, network)
    }

    /** The error reaches the player only after this many retries (and once it needs the data). */
    override fun getMinimumLoadableRetryCount(dataType: Int): Int =
        maxOf(super.getMinimumLoadableRetryCount(dataType), LoadRetry.NETWORK_RETRIES)

    private companion object {
        val NO_RETRY_HTTP = setOf(403, 410, 429)
    }
}
