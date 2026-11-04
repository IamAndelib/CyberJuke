package io.github.iamandelib.cyberjuke.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebRulesTest {
    @Test
    fun capacitorsFileRoutesOnTheAppsOwnOriginAreRefused() {
        assertTrue(WebRules.isFileRoute("localhost", "/_capacitor_file_/data/user/0/x/files/a", "localhost"))
        assertTrue(WebRules.isFileRoute("localhost", "/_capacitor_content_/com.android.externalstorage.documents/tree/x", "localhost"))
        assertFalse(WebRules.isFileRoute("localhost", "/_local/art/0123456789abcdef.jpg", "localhost"))
        assertFalse(WebRules.isFileRoute("localhost", "/index.html", "localhost"))
        assertFalse(WebRules.isFileRoute("i.ytimg.com", "/_capacitor_file_/x", "localhost"))
        assertFalse(WebRules.isFileRoute("localhost", null, "localhost"))
    }

    @Test
    fun onlyAnHttpsPageIsOpened() {
        assertTrue(WebRules.mayNavigate("https"))
        assertTrue(WebRules.mayNavigate("HTTPS"))
        for (s in listOf("http", "file", "intent", "content", "market", "javascript", "data", null)) assertFalse("$s", WebRules.mayNavigate(s))
    }
}
