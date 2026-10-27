package io.github.iamandelib.cyberjuke.net

import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

/** HostLock against a loopback HTTP server: redirects to another host fail, same-host ones work. */
class HostLockTest {
    private val loopback = InetAddress.getByName("127.0.0.1")
    private lateinit var server: ServerSocket
    private val paths = ArrayList<String>()

    @Before
    fun start() {
        server = ServerSocket(0, 8, loopback)
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (_: IOException) { break }
                socket.use { s ->
                    val reader = s.getInputStream().bufferedReader()
                    val path = reader.readLine()?.split(' ')?.getOrNull(1) ?: return@use
                    while (reader.readLine()?.isNotEmpty() == true) Unit
                    synchronized(paths) { paths.add(path) }
                    val port = server.localPort
                    val head = when (path) {
                        "/same" -> "HTTP/1.1 302 Found\r\nLocation: /ok\r\n"
                        "/away" -> "HTTP/1.1 302 Found\r\nLocation: http://elsewhere.test:$port/ok\r\n"
                        else -> "HTTP/1.1 200 OK\r\n"
                    }
                    s.getOutputStream().write("${head}Content-Length: 2\r\nConnection: close\r\n\r\nok".toByteArray())
                }
            }
        }
    }

    @After
    fun stop() {
        server.close()
        NetPrefs.resetForTest()
    }

    /** A client locked to 127.0.0.1 that resolves every name to the loopback server. */
    private val client = OkHttpClient.Builder()
        .dns(object : Dns {
            override fun lookup(hostname: String): List<InetAddress> = listOf(loopback)
        })
        .addNetworkInterceptor(HostLock("127.0.0.1"))
        .build()

    private fun get(path: String): String {
        val request = Request.Builder().url("http://127.0.0.1:${server.localPort}$path").build()
        client.newCall(request).execute().use { return it.body!!.string() }
    }

    @Test
    fun aRedirectOnTheSameHostIsFollowed() {
        assertEquals("ok", get("/same"))
        assertEquals(listOf("/same", "/ok"), synchronized(paths) { paths.toList() })
    }

    @Test
    fun aRedirectToAnotherHostFailsBeforeItsRequestGoesOut() {
        val e = assertThrows(IOException::class.java) { get("/away") }
        assertTrue(e.message!!.contains("127.0.0.1"))
        assertEquals(listOf("/away"), synchronized(paths) { paths.toList() })
    }

    @Test
    fun theLyricsClientsAreLockedToLrclib() {
        for (mode in listOf(Ipv4Mode.OFF, Ipv4Mode.ALWAYS)) {
            NetPrefs.setMode(mode)
            val locks = Http.currentLyrics().networkInterceptors.filterIsInstance<HostLock>()
            assertEquals(listOf("lrclib.net"), locks.map { it.host })
            assertTrue(Http.current().networkInterceptors.none { it is HostLock })
            assertTrue(Http.currentStreaming().networkInterceptors.none { it is HostLock })
        }
    }
}
