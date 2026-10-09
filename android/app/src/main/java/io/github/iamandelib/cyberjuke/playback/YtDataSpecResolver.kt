package io.github.iamandelib.cyberjuke.playback

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.ResolvingDataSource
import io.github.iamandelib.cyberjuke.net.Hosts
import io.github.iamandelib.cyberjuke.yt.YtCompat
import java.io.IOException
import java.util.concurrent.atomic.AtomicLong

/**
 * Maps cyberjuke://yt/<id> to the real googlevideo URL + headers, on the loader thread. Every
 * load goes through here: only https YouTube media URLs leave it (L5), plus the CI test tone
 * asset on debuggable builds.
 */
@OptIn(UnstableApi::class)
internal object YtDataSpecResolver : ResolvingDataSource.Resolver {
    private val requestNumber = AtomicLong()

    /** Set by PlaybackService: debuggable builds play the CI tone asset. */
    @Volatile
    var allowCiTone = false

    override fun resolveDataSpec(dataSpec: DataSpec): DataSpec {
        val ytId = JukeUris.ytIdOf(dataSpec.uri)
        if (ytId == LaunchOptions.CI_TONE && allowCiTone) {
            return dataSpec.buildUpon().setUri(Uri.parse(LaunchOptions.CI_TONE_ASSET)).build()
        }
        val url: String
        val headers = HashMap(dataSpec.httpRequestHeaders)
        if (ytId != null) {
            // A load that starts past byte 0 resumes a track: keep its itag (same file).
            val stream = StreamResolver.resolve(ytId, midStream = dataSpec.position > 0)
            url = stream.url
            headers.putAll(stream.headers)
        } else {
            // An HLS manifest, variant or segment (the manifest-only fallback).
            url = dataSpec.uri.toString()
            headers.putAll(YtCompat.streamHeaders(url))
        }
        if (!Hosts.isAllowedMediaUrl(url)) {
            throw IOException("Refusing to load a non-https or non-YouTube media URL")
        }

        val isVideoPlayback = Uri.parse(url).path?.startsWith("/videoplayback") == true
        val finalUrl = if (ytId != null && YtUrls.wantsRn(url)) {
            url + "&rn=" + requestNumber.incrementAndGet()
        } else {
            url
        }

        val builder = dataSpec.buildUpon()
            .setUri(Uri.parse(finalUrl))
            .setHttpRequestHeaders(headers)
        if (isVideoPlayback && StreamResolver.USE_POST_BODY) {
            builder.setHttpMethod(DataSpec.HTTP_METHOD_POST)
                .setHttpBody(StreamResolver.POST_BODY)
        }
        return builder.build()
    }
}
