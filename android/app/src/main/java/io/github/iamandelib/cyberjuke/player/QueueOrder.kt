package io.github.iamandelib.cyberjuke.player

/**
 * Pure helpers for "Add to queue" (play next, FIFO). No Android or Media3 types, so they are
 * unit-tested on the plain JVM (QueueOrderTest).
 */
internal object QueueOrder {

    /**
     * Returns [order] (a play order: every playlist index exactly once) with the [queued]
     * indices taken out and put right after [current], in the order given (FIFO).
     *
     * Edge cases:
     * - [current] itself, duplicates and indices not in [order] are ignored in [queued].
     * - If [current] is not in [order] (e.g. C.INDEX_UNSET), the queued indices go first.
     * - Every other index keeps its relative order, so calling it again on the result
     *   returns the same array (idempotent; callers compare before applying).
     */
    fun placeNext(order: IntArray, current: Int, queued: List<Int>): IntArray {
        val present = order.toHashSet()
        val q = LinkedHashSet<Int>()
        for (i in queued) if (i != current && i in present) q.add(i)
        if (q.isEmpty()) return order.copyOf()
        val rest = order.filter { it !in q }
        val at = rest.indexOf(current)
        val out = ArrayList<Int>(order.size)
        if (at < 0) {
            out.addAll(q)
            out.addAll(rest)
        } else {
            out.addAll(rest.subList(0, at + 1))
            out.addAll(q)
            out.addAll(rest.subList(at + 1, rest.size))
        }
        return out.toIntArray()
    }

    /**
     * Moves (`from` to `to`, Player.moveMediaItem semantics: the item ends up at `to`) that turn
     * the playlist 0..n-1 into [target], a permutation of 0..n-1. Selection-style: a position
     * that already holds the right item costs nothing, so moving k queued items takes about k
     * moves. Returns an empty list if [target] is not a permutation.
     */
    fun moves(target: IntArray): List<Pair<Int, Int>> {
        val n = target.size
        if (target.sorted() != (0 until n).toList()) return emptyList()
        val list = (0 until n).toMutableList()
        val out = ArrayList<Pair<Int, Int>>()
        for (p in 0 until n) {
            val at = list.indexOf(target[p])
            if (at != p) {
                list.add(p, list.removeAt(at))
                out.add(at to p)
            }
        }
        return out
    }
}
