package io.github.iamandelib.cyberjuke.bridge

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeWebViewClient
import io.github.iamandelib.cyberjuke.local.LocalLibrary
import io.github.iamandelib.cyberjuke.playback.ArtStore
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException

/**
 * Capacitor's WebView client, plus the covers of liked songs saved on the phone: a page's
 * request for one is answered from [ArtStore] (offline too, and without the network online),
 * every other request as before. [artDir] is where they are kept. A local song's cover too
 * (`/_local/art/<id>.jpg` on the page's own origin), from local music's list. Capacitor's file
 * routes are refused, and a navigation away opens only an https page ([WebRules]).
 */
class ArtWebViewClient(private val host: Bridge, artDir: File) : BridgeWebViewClient(host) {
    init {
        ArtStore.init(artDir)
    }

    /** A local song's cover, `/_local/art/<16 hex>.jpg` on the page's own origin, when the phone keeps one. */
    private fun localCover(request: WebResourceRequest): File? {
        if (request.method != "GET") return null
        val u = request.url
        if (u.host != host.host) return null
        val hex = LOCAL_ART.matchEntire(u.path ?: return null)?.groupValues?.get(1) ?: return null
        return LocalLibrary.coverFile("loc:$hex")
    }

    private companion object {
        val LOCAL_ART = Regex("^/_local/art/([0-9a-f]{16})\\.jpg$")
    }

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        if (WebRules.isFileRoute(request.url.host, request.url.path, host.host)) {
            return WebResourceResponse("text/plain", null, 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
        val file = localCover(request) ?: ArtStore.files?.fileFor(request.method, request.url.toString()) ?: return super.shouldInterceptRequest(view, request)
        return try {
            WebResourceResponse("image/jpeg", null, FileInputStream(file))
        } catch (_: IOException) {
            super.shouldInterceptRequest(view, request)
        }
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        if (WebRules.mayNavigate(request.url.scheme)) super.shouldOverrideUrlLoading(view, request) else true
}
