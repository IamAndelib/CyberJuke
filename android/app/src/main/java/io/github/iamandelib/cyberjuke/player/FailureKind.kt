package io.github.iamandelib.cyberjuke.player

/**
 * What kind of failure an extraction or stream load hit. [YtCompat.classify] maps NewPipe
 * exceptions here; HTTP status codes from streaming are mapped by [TrackErrorPolicy].
 */
internal enum class FailureKind {
    /** Network-wide: YouTube wants a sign-in / captcha from this IP. */
    BOT_CHECK,

    /** Network-wide: HTTP 429 or "try again later". */
    RATE_LIMIT,

    /** No connection, timeout, HTTP 5xx: retry later, the track is fine. */
    NETWORK,

    /** This video only: private, removed, age or geo restricted, paid... */
    CONTENT,

    /** NewPipe could not parse YouTube's answer: YouTube changed something, update the app. */
    BROKEN,

    /** Anything else; treated like a per-video failure. */
    OTHER,
    ;

    val blockReason: BlockReason?
        get() = when (this) {
            BOT_CHECK -> BlockReason.BOT_CHECK
            RATE_LIMIT -> BlockReason.RATE_LIMIT
            else -> null
        }
}
