package io.github.iamandelib.cyberjuke.yt

import io.github.iamandelib.cyberjuke.net.Hosts
import io.github.iamandelib.cyberjuke.net.Http
import io.github.iamandelib.cyberjuke.net.NetBlock
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Call
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.atomic.AtomicInteger

/** NewPipeExtractor [Downloader] backed by OkHttp (modelled on NewPipe's DownloaderImpl). */
internal class DownloaderImpl private constructor(private val client: Call.Factory) : Downloader() {

    override fun execute(request: Request): Response {
        // A cancelled load (ExoPlayer interrupts the loader thread on a skip) stops here, so
        // rapid skipping leaves no extractions running on (L14).
        if (Thread.currentThread().isInterrupted) throw InterruptedIOException("interrupted")
        val url = request.url()
        // Y1: nothing goes to YouTube during a back-off, whoever asks (every request here is
        // NewPipe's or InnerTube's, so YouTube's).
        NetBlock.check()
        val method = request.httpMethod()
        val data: ByteArray? = request.dataToSend()
        LeanRequests.answer(url, data)?.let { return it }
        requests.incrementAndGet()
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
        /** Requests sent to the network (the canary checks the lean path's count). */
        val requests = AtomicInteger()

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

/**
 * The lean stream resolver's filter ([YtCompat.extractLean]). While it runs on this thread,
 * the extractor's requests that streams don't need are answered here without the network:
 * - the WEB client's visitor id and metadata player request (title, thumbnails): refused; the
 *   extractor treats them as optional and carries on;
 * - `next` (related videos, comments): an empty JSON object.
 * Only the visionOS visitor id and player request (where the streams come from) go out.
 */
internal object LeanRequests {
    private val active = ThreadLocal<Boolean>()

    /** The `next` stand-in: valid JSON, long enough for the extractor's sanity check. */
    private const val EMPTY_NEXT =
        "{\"responseContext\":{},\"contents\":{},\"cyberjuke\":\"next is not needed for streams\"}"

    fun <T> during(work: () -> T): T {
        active.set(true)
        try {
            return work()
        } finally {
            active.remove()
        }
    }

    /** What to skip, by URL and body (pure; LeanResolverTest). */
    enum class Skip { NONE, REFUSE, EMPTY_JSON }

    fun classify(url: String, body: ByteArray?): Skip {
        val u = url.toHttpUrlOrNull() ?: return Skip.NONE
        if (!Hosts.isYouTube(u.host)) return Skip.NONE
        val path = u.encodedPath
        if (!path.startsWith("/youtubei/v1/")) return Skip.NONE
        val endpoint = path.removePrefix("/youtubei/v1/")
        if (endpoint == "next") return Skip.EMPTY_JSON
        val web = body != null && String(body, Charsets.UTF_8).contains("\"clientName\":\"WEB\"")
        return when {
            endpoint == "visitor_id" && web -> Skip.REFUSE
            endpoint == "player" && (web || u.queryParameter("\$fields")?.contains("microformat") == true) -> Skip.REFUSE
            else -> Skip.NONE
        }
    }

    /** The local answer for a skipped request (or throws), or null to send it. */
    fun answer(url: String, body: ByteArray?): Response? {
        if (active.get() != true) return null
        return when (classify(url, body)) {
            Skip.NONE -> null
            Skip.REFUSE -> throw IOException("lean: not needed for streams")
            Skip.EMPTY_JSON -> Response(
                200,
                "OK",
                mapOf("Content-Type" to listOf("application/json")),
                EMPTY_NEXT,
                url,
            )
        }
    }
}
