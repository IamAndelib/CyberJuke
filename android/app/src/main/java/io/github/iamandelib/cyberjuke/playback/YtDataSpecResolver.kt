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
 * asset on debuggable builds. A track saved whole in the listening cache ([AudioCache]) leaves
 * with no URL at all, only its cache key. A Jukebox MP3 (cyberjuke://mp3/<file>) leaves as
 * its latex.gg link, as is: no extraction and no YouTube headers, only its turn at the gate.
 */
@OptIn(UnstableApi::class)
internal object YtDataSpecResolver : ResolvingDataSource.Resolver {
    private val requestNumber = AtomicLong()

    /** Set by PlaybackService: debuggable builds play the CI tone asset. */
    @Volatile
    var allowCiTone = false

    /** Only the playing track and the next one open their stream ([OpenGate]; PlaybackService sets it). */
    val gate = OpenGate()

    override fun resolveDataSpec(dataSpec: DataSpec): DataSpec {
        JukeUris.mp3UrlOf(dataSpec.uri)?.let { url ->
            // Its turn, too: prepared early, the file after next would be requested now.
            gate.await(url)
            return mp3Spec(dataSpec, url)
        }
        val ytId = JukeUris.ytIdOf(dataSpec.uri)
        if (ytId == LaunchOptions.CI_TONE && allowCiTone) {
            return dataSpec.buildUpon().setUri(Uri.parse(LaunchOptions.CI_TONE_ASSET)).build()
        }
        if (ytId != null) {
            // The track after next waits for its turn (prepared early, it would extract now).
            gate.await(ytId)
            val midStream = dataSpec.position > 0
            // Saved whole in the listening cache: played from it, no extraction, no request. Its
            // URI stays ours (it has no stream URL): see CacheMissGuard.
            StreamResolver.cachedKey(ytId, midStream)?.let { key ->
                return dataSpec.buildUpon().setKey(key).build()
            }
            // A load that starts past byte 0 resumes a track: keep its itag (same file).
            return streamSpec(dataSpec, ytId, StreamResolver.resolve(ytId, midStream))
        }
        // An HLS manifest, variant or segment (the manifest-only fallback): no cache key, so it
        // is never cached.
        val url = dataSpec.uri.toString()
        val headers = HashMap(dataSpec.httpRequestHeaders)
        headers.putAll(YtCompat.streamHeaders(url))
        return requestSpec(dataSpec, url, headers, rn = false)
    }

    /**
     * The request for [stream] (of [ytId]) from [dataSpec]: its URL and headers, and for an
     * audio-only stream the cache key `yt:<ytId>:<itag>:<clen>` ([CacheKeys]), so it is read from
     * and written to the listening cache (a muxed fallback, with video, is not kept). The liked
     * saver's too.
     */
    @Throws(IOException::class)
    fun streamSpec(dataSpec: DataSpec, ytId: String, stream: ResolvedStream): DataSpec {
        val headers = HashMap(dataSpec.httpRequestHeaders)
        headers.putAll(stream.headers)
        val spec = requestSpec(dataSpec, stream.url, headers, rn = true)
        if (!stream.audioOnly || stream.itag <= 0) return spec
        return spec.buildUpon().setKey(CacheKeys.of(ytId, stream.itag, StreamUrls.clen(stream.url))).build()
    }

    /** A Jukebox MP3: the file itself, from latex.gg ([Hosts.isLatexMp3]), with the request's own headers. */
    @Throws(IOException::class)
    fun mp3Spec(dataSpec: DataSpec, url: String): DataSpec {
        if (!Hosts.isLatexMp3(url)) throw IOException("Refusing to load an MP3 that isn't a latex.gg share link")
        return dataSpec.buildUpon().setUri(Uri.parse(url)).build()
    }

    private fun requestSpec(dataSpec: DataSpec, url: String, headers: Map<String, String>, rn: Boolean): DataSpec {
        if (!Hosts.isAllowedMediaUrl(url)) {
            throw IOException("Refusing to load a non-https or non-YouTube media URL")
        }

        val isVideoPlayback = Uri.parse(url).path?.startsWith("/videoplayback") == true
        val finalUrl = if (rn && YtUrls.wantsRn(url)) {
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
