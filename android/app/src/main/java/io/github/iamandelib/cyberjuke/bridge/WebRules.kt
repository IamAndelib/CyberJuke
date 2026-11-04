package io.github.iamandelib.cyberjuke.bridge

/**
 * What the WebView may reach beyond the app's own pages. Pure (WebRulesTest). The page never
 * uses Capacitor's file routes (no convertFileSrc): they are refused, so nothing in the page
 * can read the app's files or a granted folder by URL. A navigation away from the app opens
 * only an https page, outside the app (src/ui/links.ts opens nothing else); file:, intent:,
 * content: and the like go nowhere.
 */
internal object WebRules {
    private val FILE_ROUTES = listOf("/_capacitor_file_", "/_capacitor_content_")

    /** A request to one of Capacitor's file routes on the app's own origin. */
    fun isFileRoute(host: String?, path: String?, appHost: String?): Boolean =
        host != null && host == appHost && path != null && FILE_ROUTES.any { path.startsWith(it) }

    /** A navigation the page may make: https only. */
    fun mayNavigate(scheme: String?): Boolean = scheme.equals("https", ignoreCase = true)
}
