package io.github.iamandelib.cyberjuke.yt

import io.github.iamandelib.cyberjuke.net.Families
import io.github.iamandelib.cyberjuke.net.Family
import io.github.iamandelib.cyberjuke.net.LimitPolicy
import io.github.iamandelib.cyberjuke.net.NetBlock
import io.github.iamandelib.cyberjuke.net.NetPrefs
import io.github.iamandelib.cyberjuke.net.Surface
import java.io.InterruptedIOException

/**
 * Runs YouTube work for one [Surface] under the back-off rules: refused during a back-off
 * ([NetBlock.check]); a bot check or rate limit first switches to IPv4 or retries once
 * ([LimitPolicy]) and only then trips the back-off; success ends an unproven state.
 * Blocking (the retry waits [LimitPolicy.RETRY_DELAY_MS]); never on the main thread.
 */
internal object YtGuard {
    /** Overridable for tests. Interruptible: a cancelled load stops waiting. */
    @Volatile
    var sleep: (Long) -> Unit = { Thread.sleep(it) }

    fun <T> run(surface: Surface, work: () -> T): T {
        NetBlock.check(surface)
        var retried = false
        var switched = false
        while (true) {
            Families.clearThread()
            val failure = try {
                val result = work()
                NetBlock.requestSucceeded(surface)
                return result
            } catch (e: Exception) {
                e
            }
            val reason = YtCompat.classify(failure).blockReason ?: throw failure
            val viaIpv6 = Families.lastOnThread() == Family.IPV6
            when (LimitPolicy.decide(viaIpv6, !switched && NetPrefs.canSwitchToIpv4(), retried)) {
                LimitPolicy.Action.SWITCH_TO_IPV4 -> {
                    switched = true
                    NetPrefs.switchToIpv4Automatically()
                }
                LimitPolicy.Action.RETRY_LATER -> {
                    retried = true
                    try {
                        sleep(LimitPolicy.RETRY_DELAY_MS)
                    } catch (e: InterruptedException) {
                        Thread.currentThread().interrupt()
                        throw InterruptedIOException("interrupted").apply { initCause(failure) }
                    }
                }
                LimitPolicy.Action.BLOCK -> {
                    NetBlock.trip(reason, surface)
                    throw failure
                }
            }
            // Someone else may have tripped meanwhile: then stop here too.
            NetBlock.check(surface)
        }
    }
}
