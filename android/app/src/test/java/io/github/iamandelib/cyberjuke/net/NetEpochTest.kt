package io.github.iamandelib.cyberjuke.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NetEpochTest {
    @Test
    fun theFirstNetworkAndItsFirstAddressesAreTheBaseline() {
        val e = NetEpochState()
        assertFalse(e.onNetwork("100"))
        assertFalse(e.onAddresses("100", setOf("192.168.1.5", "fe80::1")))
        assertFalse(e.onAddresses("100", setOf("192.168.1.5", "fe80::1"))) // same again
        assertEquals(0, e.generation)
    }

    @Test
    fun aSwitchOfNetworkOrNewAddressesIsANewGeneration() {
        val e = NetEpochState()
        e.onNetwork("100")
        e.onAddresses("100", setOf("192.168.1.5"))
        // Wi-Fi to LTE.
        assertTrue(e.onNetwork("101"))
        assertEquals(1, e.generation)
        // LTE's addresses arrive: the baseline of the new network, not another change.
        assertFalse(e.onAddresses("101", setOf("10.20.30.40")))
        assertFalse(e.onNetwork("101"))
        assertEquals(1, e.generation)
        // A new address on the same network (re-attach, new IPv6 address).
        assertTrue(e.onAddresses("101", setOf("10.20.30.41")))
        assertEquals(2, e.generation)
        // Link properties of a network we had not heard of yet count as a switch.
        assertTrue(e.onAddresses("102", setOf("192.168.1.9")))
        assertEquals(3, e.generation)
    }
}
