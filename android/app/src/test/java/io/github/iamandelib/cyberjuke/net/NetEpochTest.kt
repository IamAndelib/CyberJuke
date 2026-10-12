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

    @Test
    fun aChangeSaysWhichAddressFamiliesChanged() {
        val e = NetEpochState()
        e.onNetwork("100")
        assertEquals(emptySet<Family>(), e.addressesChanged("100", setOf("192.168.1.5", "2001:db8::a", "fe80::1")))
        // A new (temporary) IPv6 address: URLs bound to IPv4 still work.
        assertEquals(setOf(Family.IPV6), e.addressesChanged("100", setOf("192.168.1.5", "2001:db8::b", "fe80::1")))
        assertEquals(1, e.generation)
        // A new IPv4 address only.
        assertEquals(setOf(Family.IPV4), e.addressesChanged("100", setOf("192.168.1.6", "2001:db8::b", "fe80::1")))
        // Both at once, and the same again (no change).
        assertEquals(NetEpochState.ALL_FAMILIES, e.addressesChanged("100", setOf("10.0.0.2", "2001:db8::c")))
        assertEquals(emptySet<Family>(), e.addressesChanged("100", setOf("10.0.0.2", "2001:db8::c")))
        // Another network: everything.
        assertEquals(NetEpochState.ALL_FAMILIES, e.addressesChanged("101", setOf("10.0.0.2")))
        assertEquals(4, e.generation)
    }

    @Test
    fun addressFamiliesFromTheirText() {
        assertEquals(Family.IPV4, NetEpochState.familyOf("203.0.113.9"))
        assertEquals(Family.IPV6, NetEpochState.familyOf("2001:db8::1"))
        assertEquals(Family.IPV6, NetEpochState.familyOf("fe80::1%wlan0"))
        // An IPv6 address that only went away counts too.
        assertEquals(setOf(Family.IPV6), NetEpochState.changedFamilies(setOf("1.2.3.4", "2001:db8::1"), setOf("1.2.3.4")))
    }
}
