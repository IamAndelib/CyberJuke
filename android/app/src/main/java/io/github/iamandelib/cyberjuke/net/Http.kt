package io.github.iamandelib.cyberjuke.net

import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
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

    /** A stream, manifest or segment URL ExoPlayer may load: https on a YouTube media host. */
    fun isAllowedMediaUrl(url: String): Boolean {
        val u = url.toHttpUrlOrNull() ?: return false
        return u.isHttps && isYouTubeMedia(u.host)
    }
}
