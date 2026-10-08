package io.github.iamandelib.cyberjuke.player

import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.TimeUnit

/**
 * One shared OkHttp client for extraction, audio streaming and lyrics. Extraction and
 * streaming must share it: googlevideo URLs are bound to the IP that resolved them, so both
 * have to leave through the same address family (see [NetPrefs]).
 *
 * No Android types in this file: the JVM canary test (YouTubeCanaryTest) uses it as is.
 */
internal object Http {
    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .dns(NetPrefs.dns)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}

/**
 * Network preferences applied to [Http.client] (Y6). "Prefer IPv4": YouTube flags IPv6 ranges
 * (mobile CGNAT, some ISPs) more readily than IPv4, so resolve to IPv4 addresses only when a
 * host has any. Persisted by the app in SharedPreferences ([NetPrefsStore]) and loaded at
 * service start, before the web side runs.
 */
internal object NetPrefs {
    @Volatile
    var preferIpv4: Boolean = false
        private set

    // OkHttp 4's Dns is a plain Kotlin interface, not a fun interface: no SAM lambda.
    val dns: Dns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> =
            order(Dns.SYSTEM.lookup(hostname), preferIpv4)
    }

    /** IPv4 addresses only when [preferIpv4] and there are any; otherwise unchanged. */
    fun order(addresses: List<InetAddress>, preferIpv4: Boolean): List<InetAddress> {
        if (!preferIpv4) return addresses
        val v4 = addresses.filterIsInstance<Inet4Address>()
        return v4.ifEmpty { addresses }
    }

    /**
     * Returns true if the value changed. Pooled connections (possibly IPv6) are dropped then,
     * so the next request resolves again; cached stream URLs are bound to the old address, so
     * the caller also clears them.
     */
    fun setPreferIpv4(value: Boolean): Boolean {
        if (preferIpv4 == value) return false
        preferIpv4 = value
        try {
            Http.client.connectionPool.evictAll()
        } catch (_: Exception) {
        }
        return true
    }
}

/** Exact host checks (never substring matches on the whole URL). */
internal object Hosts {
    private fun isUnder(host: String, domain: String) = host == domain || host.endsWith(".$domain")

    /** youtube.com and its subdomains: they get the SOCS consent cookie. */
    fun isYouTube(host: String?): Boolean = host != null && isUnder(host.lowercase(), "youtube.com")

    /** Hosts the stream resolver passes raw manifest/segment URLs to with YouTube headers. */
    fun isYouTubeMedia(host: String?): Boolean {
        val h = host?.lowercase() ?: return false
        return isUnder(h, "googlevideo.com") || isUnder(h, "youtube.com")
    }

    fun hostOf(url: String): String? = url.toHttpUrlOrNull()?.host
}

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
