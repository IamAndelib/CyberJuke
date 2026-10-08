package io.github.iamandelib.cyberjuke.player

import io.github.iamandelib.cyberjuke.net.Hosts
import io.github.iamandelib.cyberjuke.net.Http
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response

/** NewPipeExtractor [Downloader] backed by OkHttp (modelled on NewPipe's DownloaderImpl). */
internal class DownloaderImpl private constructor(private val client: OkHttpClient) : Downloader() {

    override fun execute(request: Request): Response {
        val url = request.url()
        val method = request.httpMethod()
        val data: ByteArray? = request.dataToSend()
        val body: RequestBody? = when {
            data != null -> data.toRequestBody()
            method == "POST" || method == "PUT" || method == "PATCH" -> ByteArray(0).toRequestBody()
            else -> null
        }

        val builder = okhttp3.Request.Builder()
            .url(url)
            .method(method, body)
            .addHeader("User-Agent", USER_AGENT)
        if (Hosts.isYouTube(Hosts.hostOf(url))) {
            // Consent cookie (SOCS) like NewPipe; extractor-supplied Cookie headers replace it.
            builder.addHeader("Cookie", YtCompat.consentCookie())
        }
        request.headers().forEach { (name, values) ->
            builder.removeHeader(name)
            values.forEach { value -> builder.addHeader(name, value) }
        }

        client.newCall(builder.build()).execute().use { response ->
            if (response.code == 429) {
                throw RateLimitedException(url)
            }
            // OkHttp 5: body is non-null (the safe call keeps this compiling on 4.x too).
            @Suppress("UNNECESSARY_SAFE_CALL", "USELESS_ELVIS")
            val responseBody: String = response.body?.string() ?: ""
            return Response(
                response.code,
                response.message,
                response.headers.toMultimap(),
                responseBody,
                response.request.url.toString(),
            )
        }
    }

    companion object {
        /** Latest Firefox ESR on Windows, same as NewPipe. */
        const val USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"

        @Volatile private var instance: DownloaderImpl? = null

        fun get(): DownloaderImpl =
            instance ?: synchronized(this) {
                instance ?: DownloaderImpl(Http.client).also { instance = it }
            }
    }
}
