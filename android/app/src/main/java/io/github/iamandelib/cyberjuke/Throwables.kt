package io.github.iamandelib.cyberjuke

/** The first [T] in this throwable's cause chain (itself included), at most 16 deep. */
internal inline fun <reified T : Throwable> Throwable.findCause(): T? {
    var t: Throwable? = this
    var depth = 0
    while (t != null && depth < 16) {
        if (t is T) return t
        t = t.cause
        depth++
    }
    return null
}
