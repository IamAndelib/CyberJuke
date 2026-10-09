package io.github.iamandelib.cyberjuke.bridge

import io.github.iamandelib.cyberjuke.bridge.KeyErrors.Facts
import io.github.iamandelib.cyberjuke.bridge.KeyErrors.Kind
import org.junit.Assert.assertEquals
import org.junit.Test

class KeyErrorsTest {
    private fun kind(f: Facts) = KeyErrors.classify(f)

    @Test
    fun anUnrecoverableKeyAloneIsNotPermanent() {
        // Keystore2 turns BUSY and SYSTEM_ERROR into UnrecoverableKeyException("Failed to
        // obtain information about key"): without more, retry and keep the token (L3).
        assertEquals(Kind.TRANSIENT, kind(Facts()))
        // Android 13+ says it is transient or a system error: still kept.
        assertEquals(Kind.TRANSIENT, kind(Facts(keystoreTransient = true, keystoreNeedsAuth = false)))
    }

    @Test
    fun permanentOnlyWhenItReallyIs() {
        assertEquals(Kind.PERMANENT, kind(Facts(invalidated = true)))
        // Android 13+: neither transient nor about the user (a corrupt or missing key blob, M4).
        assertEquals(Kind.PERMANENT, kind(Facts(keystoreTransient = false, keystoreNeedsAuth = false)))
        assertEquals(Kind.BAD_DATA, kind(Facts(badTag = true)))
        // An invalidated key wins over a bad tag.
        assertEquals(Kind.PERMANENT, kind(Facts(invalidated = true, badTag = true)))
    }

    @Test
    fun aLockedDeviceKeepsEverything() {
        assertEquals(Kind.LOCKED, kind(Facts(notAuthenticated = true)))
        assertEquals(Kind.LOCKED, kind(Facts(keystoreTransient = false, keystoreNeedsAuth = true)))
    }
}
