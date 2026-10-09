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
    @Synchronized
    fun onAddresses(id: String, now: Set<String>): Boolean {
        if (id != network) {
            val changed = onNetwork(id)
            addresses = now
            return changed
        }
        val was = addresses
        addresses = now
        if (was == null || was == now) return false
        generation++
        return true
    }
}

internal object NetEpoch {
    private val state = NetEpochState()

    val generation: Int get() = state.generation

    fun onNetwork(id: String): Boolean = state.onNetwork(id)

    fun onAddresses(id: String, addresses: Set<String>): Boolean = state.onAddresses(id, addresses)
}
