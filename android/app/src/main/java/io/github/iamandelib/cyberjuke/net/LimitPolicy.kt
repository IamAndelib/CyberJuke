package io.github.iamandelib.cyberjuke.net

/**
 * What to do when YouTube limits a request (a bot check or rate limit), before calling it a
 * block. Pure (LimitPolicyTest); [io.github.iamandelib.cyberjuke.yt.YtGuard] carries it out.
 *
 * 1. It went out over IPv6 and the IPv4 setting is Auto: switch to IPv4 and retry at once.
 *    YouTube judges IPv6 in large blocks, so IPv4 usually just works.
 * 2. Otherwise, the first time: wait [RETRY_DELAY_MS] and retry once. A single refusal is often
 *    a passing hiccup.
 * 3. Otherwise: a block ([NetBlock.trip]).
 */
internal object LimitPolicy {
    const val RETRY_DELAY_MS = 8_000L

    enum class Action { SWITCH_TO_IPV4, RETRY_LATER, BLOCK }

    fun decide(viaIpv6: Boolean, canSwitchToIpv4: Boolean, retried: Boolean): Action = when {
        viaIpv6 && canSwitchToIpv4 -> Action.SWITCH_TO_IPV4
        !retried -> Action.RETRY_LATER
        else -> Action.BLOCK
    }
}
