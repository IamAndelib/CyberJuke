package io.github.iamandelib.cyberjuke.net

/**
 * Which default network we are on (H1). googlevideo stream URLs are bound to the IP that
 * resolved them, so a switch (Wi-Fi to LTE) or a new address on the same network makes every
 * cached URL answer 403. Each change bumps [generation]: a URL resolved in an older
 * generation that gets a 403 is re-resolved, never taken as a block (TrackErrorPolicy).
 *
 * Fed by PlaybackService's ConnectivityManager default-network callback. Pure apart from the
 * process-wide instance (NetEpochTest). Thread-safe.
 */
internal class NetEpochState {
    private var network: String? = null
    private var addresses: Set<String>? = null

    @get:Synchronized
    var generation = 0
        private set

    /** The default network is now [id]. Returns true if that is a change (not the first). */
    @Synchronized
    fun onNetwork(id: String): Boolean {
        val was = network
        if (was == id) return false
        network = id
        addresses = null
        if (was == null) return false
        generation++
        return true
    }

    /**
     * [id]'s addresses are [now]. Returns true if they changed from addresses already known
     * for it (the first report for a network is its baseline, not a change).
     */
    fun onAddresses(id: String, now: Set<String>): Boolean = addressesChanged(id, now).isNotEmpty()

    /**
     * Like [onAddresses], but says which address families changed: both for another network,
     * only IPv6 when just its (often rotating) IPv6 addresses did. URLs bound to a family that
     * didn't change still work. Empty: no change.
     */
    @Synchronized
    fun addressesChanged(id: String, now: Set<String>): Set<Family> {
        if (id != network) {
            val changed = onNetwork(id)
            addresses = now
            return if (changed) ALL_FAMILIES else emptySet()
        }
        val was = addresses
        addresses = now
        if (was == null || was == now) return emptySet()
        generation++
        return changedFamilies(was, now)
    }

    companion object {
        val ALL_FAMILIES: Set<Family> = setOf(Family.IPV4, Family.IPV6)

        /** "2001:db8::1" (or "fe80::1%wlan0") is IPv6, "192.0.2.1" IPv4. */
        fun familyOf(address: String): Family = if (address.contains(':')) Family.IPV6 else Family.IPV4

        /** The families whose addresses differ between [was] and [now]. */
        fun changedFamilies(was: Set<String>, now: Set<String>): Set<Family> =
            ALL_FAMILIES.filterTo(HashSet()) { f ->
                was.filterTo(HashSet()) { familyOf(it) == f } != now.filterTo(HashSet()) { familyOf(it) == f }
            }
    }
}

internal object NetEpoch {
    private val state = NetEpochState()

    val generation: Int get() = state.generation

    fun onNetwork(id: String): Boolean = state.onNetwork(id)

    fun onAddresses(id: String, addresses: Set<String>): Boolean = state.onAddresses(id, addresses)

    fun addressesChanged(id: String, addresses: Set<String>): Set<Family> = state.addressesChanged(id, addresses)
}
