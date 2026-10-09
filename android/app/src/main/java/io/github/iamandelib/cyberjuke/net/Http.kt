package io.github.iamandelib.cyberjuke.net

import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.util.concurrent.TimeUnit

/**
 * The HTTP client for extraction, audio streaming and lyrics. Extraction and streaming must
 * share it: googlevideo URLs are bound to the IP that resolved them, so both have to leave
 * through the same address family (see [NetPrefs]).
 *
 * Two OkHttp clients behind it, each with its own connection pool: the system's choice of
 * address, and IPv4 only. [client] picks one per request, so the moment [NetPrefs] switches to
 * IPv4 every new request goes out on an IPv4 connection; a busy IPv6 connection (a track still
 * streaming) can never be reused for it, and nothing has to be closed on the caller's thread.
 *
 * No Android types in this file: the JVM canary test (YouTubeCanaryTest) uses it as is.
 */
internal object Http {
    private fun build(dns: Dns): OkHttpClient = OkHttpClient.Builder()
        .dns(dns)
        .connectionPool(ConnectionPool())
        .addNetworkInterceptor(Families.interceptor)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        // Everything we fetch is https: never follow a redirect down to http (L5).
        .followSslRedirects(false)
        .build()

    private val system = lazy { build(Dns.SYSTEM) }
    private val ipv4 = lazy { build(NetPrefs.ipv4Dns) }

    /** The client for a request made now. */
    fun current(): OkHttpClient = if (NetPrefs.preferIpv4) ipv4.value else system.value

    // OkHttp 4's Call.Factory is a plain Kotlin interface, not a fun interface: no SAM lambda.
    val client: Call.Factory = object : Call.Factory {
        override fun newCall(request: Request): Call = current().newCall(request)
    }

    /** Drops idle pooled connections, so the next request resolves again (a new network). */
    fun evictConnections() {
        for (c in listOf(system, ipv4)) {
            if (!c.isInitialized()) continue
            try {
                c.value.connectionPool.evictAll()
            } catch (_: Exception) {
            }
        }
    }
}

/** IPv4 or IPv6: which one a YouTube request actually went out on. */
internal enum class Family { IPV4, IPV6 }

/**
 * Records the address family of every YouTube request (a network interceptor sees the real
 * connection). A limit that came back over IPv6 is the cue to switch to IPv4 ([NetPrefs]).
 * Extraction runs synchronously on the caller's thread, so [lastOnThread] is the family of the
 * request that just failed there; [last] is the latest one anywhere (diagnostics).
 */
internal object Families {
    private val onThread = ThreadLocal<Family?>()

    @Volatile
    var last: Family? = null
        private set

    val interceptor = Interceptor { chain ->
        val address = chain.connection()?.socket()?.inetAddress
        if (address != null && Hosts.isYouTubeTraffic(chain.request().url.host)) record(familyOf(address))
        chain.proceed(chain.request())
    }

    fun familyOf(address: InetAddress): Family = if (address is Inet6Address) Family.IPV6 else Family.IPV4

    fun record(f: Family) {
        onThread.set(f)
        last = f
    }

    /** The family of this thread's last YouTube request since [clearThread], or null. */
    fun lastOnThread(): Family? = onThread.get()

    fun clearThread() = onThread.remove()
}

/** "Prefer IPv4" setting (Y6). AUTO switches on its own when YouTube limits us over IPv6. */
internal enum class Ipv4Mode { AUTO, ALWAYS, OFF }

/**
 * Network preferences applied to [Http.client] (Y6). YouTube judges IPv6 addresses in large
 * blocks (a whole home network or carrier range), so they get bot checks far more often than
 * IPv4; resolving to IPv4 addresses only (when a host has any) avoids that.
 *
 * - ALWAYS: IPv4 whenever there is one. OFF: whatever the system picks.
 * - AUTO (default): the system's pick until YouTube limits a request that went out over IPv6;
 *   then IPv4 for this kind of network (Wi-Fi, mobile data...) for [AUTO_MS]. The switch
 *   applies at once; an expired one only lapses on the next network change or app start, so
 *   the family never flips under a playing track.
 *
 * Persisted by the app in SharedPreferences ([io.github.iamandelib.cyberjuke.playback.NetPrefsStore])
 * through [onChange] and loaded at service start, before the web side runs.
 */
internal object NetPrefs {
    /** How long an automatic switch to IPv4 is remembered for a network. */
    const val AUTO_MS = 24L * 60L * 60L * 1000L

    @Volatile
    var mode: Ipv4Mode = Ipv4Mode.AUTO
        private set

    /** The kind of network we are on ("wifi", "cellular"...), the key of the AUTO memory. */
    @Volatile
    var networkKey: String = "default"
        private set

    /** networkKey -> until when AUTO keeps IPv4 there. */
    private val autoUntil = HashMap<String, Long>()

    /** AUTO has switched this network to IPv4 (evaluated on a switch, network change or load). */
    @Volatile
    var autoActive: Boolean = false
        private set

    @Volatile
    var clock: () -> Long = { System.currentTimeMillis() }

    /**
     * Called after the user's choice or the AUTO memory changed (persist it); the argument says
     * whether the family in force changed too (drop cached stream URLs then).
     */
    @Volatile
    var onChange: ((familyChanged: Boolean) -> Unit)? = null

    val preferIpv4: Boolean
        get() = when (mode) {
            Ipv4Mode.ALWAYS -> true
            Ipv4Mode.OFF -> false
            Ipv4Mode.AUTO -> autoActive
        }

    /** AUTO, and not on IPv4 yet: a limit over IPv6 may switch. */
    fun canSwitchToIpv4(): Boolean = mode == Ipv4Mode.AUTO && !autoActive

    /** IPv4 addresses only, where a host has any ([Http]'s IPv4 client). */
    val ipv4Dns: Dns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> = ipv4Only(Dns.SYSTEM.lookup(hostname))
    }

    /** The IPv4 addresses if there are any; otherwise all of them (an IPv6-only host). */
    fun ipv4Only(addresses: List<InetAddress>): List<InetAddress> =
        addresses.filterIsInstance<Inet4Address>().ifEmpty { addresses }

    /**
     * Applies a saved or chosen mode and AUTO memory. Returns true if the family in force
     * changed (the caller drops cached stream URLs then).
     */
    @Synchronized
    fun load(mode: Ipv4Mode, memory: Map<String, Long>): Boolean {
        val before = preferIpv4
        this.mode = mode
        autoUntil.clear()
        autoUntil.putAll(memory)
        autoActive = remembered(networkKey)
        return applied(before)
    }

    /** The user picked [mode]. Returns true if the family in force changed. */
    @Synchronized
    fun setMode(mode: Ipv4Mode): Boolean {
        val before = preferIpv4
        this.mode = mode
        return applied(before).also { onChange?.invoke(it) }
    }

    /** The default network is now of kind [key]. Returns true if the family in force changed. */
    @Synchronized
    fun onNetwork(key: String): Boolean {
        // Capabilities change often on the same network: only a new kind re-reads the memory,
        // so an expired switch lapses at a real network change, never mid-song.
        if (key == networkKey) return false
        val before = preferIpv4
        networkKey = key
        autoActive = remembered(key)
        return applied(before)
    }

    /** YouTube limited us over IPv6 in AUTO: IPv4 for this network from now on. */
    @Synchronized
    fun switchToIpv4Automatically(): Boolean {
        if (!canSwitchToIpv4()) return false
        val before = preferIpv4
        autoUntil[networkKey] = clock() + AUTO_MS
        autoActive = true
        onChange?.invoke(applied(before))
        return true
    }

    /** The AUTO memory still in force (for persisting). */
    @Synchronized
    fun memory(): Map<String, Long> {
        val now = clock()
        autoUntil.entries.removeAll { it.value <= now }
        return HashMap(autoUntil)
    }

    /** "wifi=1700000000000;cellular=..." (SharedPreferences), and back; bad entries are dropped. */
    fun encodeMemory(memory: Map<String, Long>): String =
        memory.entries.sortedBy { it.key }.joinToString(";") { "${it.key}=${it.value}" }

    fun decodeMemory(s: String?): Map<String, Long> {
        if (s.isNullOrBlank()) return emptyMap()
        val out = HashMap<String, Long>()
        for (part in s.split(';')) {
            val key = part.substringBefore('=', "")
            val until = part.substringAfter('=', "").toLongOrNull()
            if (key.isNotEmpty() && key.all { it.isLetterOrDigit() || it == '_' } && until != null) out[key] = until
        }
        return out
    }

    private fun remembered(key: String): Boolean = (autoUntil[key] ?: 0L) > clock()

    /** [Http] picks its client per request, so a change applies from the next request on. */
    private fun applied(before: Boolean): Boolean = preferIpv4 != before

    /** Tests only. */
    @Synchronized
    internal fun resetForTest() {
        mode = Ipv4Mode.AUTO
        networkKey = "default"
        autoUntil.clear()
        autoActive = false
        onChange = null
        clock = { System.currentTimeMillis() }
    }
}

/** Exact host checks (never substring matches on the whole URL). */
internal object Hosts {
    private fun isUnder(host: String, domain: String) = host == domain || host.endsWith(".$domain")

    /** youtube.com and its subdomains: they get the SOCS consent cookie. */
    fun isYouTube(host: String?): Boolean = host != null && isUnder(host.lowercase(), "youtube.com")

    /** YouTube's own traffic, for [Families]: media hosts and the InnerTube API (googleapis). */
    fun isYouTubeTraffic(host: String?): Boolean {
        val h = host?.lowercase() ?: return false
        return isYouTubeMedia(h) || isUnder(h, "youtubei.googleapis.com")
    }

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
