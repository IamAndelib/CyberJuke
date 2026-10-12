package io.github.iamandelib.cyberjuke.playback

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import io.github.iamandelib.cyberjuke.findCause
import io.github.iamandelib.cyberjuke.net.BlockedException

/**
 * Don't keep retrying what can never succeed or would make things worse: unavailable videos,
 * bot checks, a running back-off, and HTTP 403/410/429 (429 must never be retried; 403/410 are
 * handled by re-resolving in PlaybackService). A broken connection is retried more often than
 * ExoPlayer's default, with a capped back-off ([LoadRetry]), while the buffer keeps playing;
 * everything else keeps the default count.
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
        // What the default never retries (a malformed file, a missing one) stays that way.
        if (super.getRetryDelayMsFor(loadErrorInfo) == C.TIME_UNSET) return C.TIME_UNSET
        // Only a broken connection gets the longer run of retries; an HTTP status (5xx) or the
        // resolver's network failure (an extraction each time) keeps the default count.
        val network = LoadRetry.isNetwork(
            httpStatus = http != null,
            resolver = resolve != null,
            httpTransport = e.findCause<HttpDataSource.HttpDataSourceException>() != null,
            transportCause = LoadRetry.hasTransportCause(e),
        )
        return LoadRetry.retryDelayMs(loadErrorInfo.errorCount, network) ?: C.TIME_UNSET
    }

    /**
     * The error reaches the player only after this many retries (and once it needs the data).
     * It can't tell errors apart: [getRetryDelayMsFor] gives up sooner on the others.
     */
    override fun getMinimumLoadableRetryCount(dataType: Int): Int =
        maxOf(super.getMinimumLoadableRetryCount(dataType), LoadRetry.NETWORK_RETRIES)

    private companion object {
        val NO_RETRY_HTTP = setOf(403, 410, 429)
    }
}
