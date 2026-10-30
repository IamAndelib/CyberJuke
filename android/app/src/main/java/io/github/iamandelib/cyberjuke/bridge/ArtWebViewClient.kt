package io.github.iamandelib.cyberjuke.bridge

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeWebViewClient
import io.github.iamandelib.cyberjuke.playback.ArtStore
import java.io.File
import java.io.FileInputStream
import java.io.IOException

/**
 * Capacitor's WebView client, plus the covers of liked songs saved on the phone: a page's
 * request for one is answered from [ArtStore] (offline too, and without the network online),
 * every other request as before. [artDir] is where they are kept.
 */
class ArtWebViewClient(bridge: Bridge, artDir: File) : BridgeWebViewClient(bridge) {
    init {
        ArtStore.init(artDir)
    }

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val file = ArtStore.files?.fileFor(request.method, request.url.toString()) ?: return super.shouldInterceptRequest(view, request)
        return try {
            WebResourceResponse("image/jpeg", null, FileInputStream(file))
        } catch (_: IOException) {
            super.shouldInterceptRequest(view, request)
        }
    }
}
