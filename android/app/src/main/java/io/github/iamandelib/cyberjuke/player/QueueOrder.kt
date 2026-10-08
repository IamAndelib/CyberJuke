package io.github.iamandelib.cyberjuke.player

/**
 * Pure helpers for "Add to queue" (play next, FIFO) and autoplay. No Android or Media3 types,
 * so they are unit-tested on the plain JVM (QueueOrderTest).
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
     * A shuffle play order with the [auto] (autoplay) indices last, in list order, and the
     * [queued] indices right after [current] (see [placeNext]). Everything else keeps its
     * relative order, so only the list part stays shuffled; idempotent like [placeNext].
     * [current] may itself be an autoplay index: what is ahead of it is then autoplay only.
     */
    fun arrange(order: IntArray, current: Int, queued: List<Int>, auto: List<Int>): IntArray {
        val present = order.toHashSet()
        val autos = auto.filter { it in present }.distinct().sorted()
        val autoSet = autos.toHashSet()
        val q = queued.filter { it != current && it in present && it !in autoSet }.toHashSet()
        val seq = IntArray(order.size)
        var k = 0
        for (i in order) if (i !in q && i !in autoSet) seq[k++] = i
        for (i in autos) seq[k++] = i
        for (i in order) if (i in q) seq[k++] = i
        return placeNext(seq, current, queued.filter { it in q })
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

/**
 * The playlist operations [NativeQueue] needs; PlaybackService implements it over ExoPlayer and
 * QueueRulesTest over a fake with ExoPlayer's semantics. Indices are playlist (list) indices.
 */
internal interface QueueHost<T> {
    val count: Int

    /** -1 when the playlist is empty. */
    val currentIndex: Int
    val shuffleEnabled: Boolean

    /** The "Add to queue" serial of the item at [index], 0 if it was not user-queued. */
    fun serialAt(index: Int): Long

    /** The shuffle play order (every index exactly once), or null if unavailable. */
    fun shuffleOrder(): IntArray?
    fun setShuffleOrder(order: IntArray)
    fun moveItem(from: Int, to: Int)

    /** Inserts [items] at [at] (null = append), item k tagged with [serials][k]. */
    fun insertTagged(at: Int?, items: List<T>, serials: List<Long>)

    fun itemAt(index: Int): T

    /** The item at [index] was added by autoplay. */
    fun isAutoAt(index: Int): Boolean

    /** Replaces the playlist ([serials] as in [insertTagged]); [start] becomes current. */
    fun setItems(items: List<T>, serials: List<Long>, start: Int, positionMs: Long)

    /** Appends [items] tagged as autoplay. */
    fun appendAuto(items: List<T>)
    fun removeAt(index: Int)

    /** A user jump to [index] (Player.seekTo(index, 0)). */
    fun seekTo(index: Int)
}

/**
 * The queue rules shared by web and native (tests/spec/queue-rules.json):
 * - "Add to queue" (play next, FIFO): queued tracks play right after the current track, first in
 *   first out, shuffle or not, until each one plays or is removed. A manual jump keeps the
 *   still-queued tracks next: they move to just after the new current track, in the order they
 *   were going to play. Jumping to a queued track plays it; the others stay next.
 * - A new list ([setList]) replaces the list and the autoplay tracks; the queued tracks stay
 *   next, in order (P1).
 * - Autoplay tracks ([addAutoplay]) play after the list in the order added; shuffle reorders only
 *   the list. Repeat all/one ([onRepeatModeChanged]) and a jump to an autoplay track ([skipTo])
 *   drop the autoplay tracks still to come.
 *
 * Pending items are tracked by serial (not mediaId), so the same track queued twice stays two
 * entries. [pending]'s iteration order is their play order. Not thread-safe: call it on the
 * player's thread.
 */
internal class NativeQueue<T>(private val host: QueueHost<T>) {
    private val pending = LinkedHashSet<Long>()
    private var nextSerial = 1L

    /** Serials still waiting to play, in play order. */
    val pendingSerials: Set<Long> get() = pending

    /** The current item changed (any reason): keep the pending ones right after it. */
    fun onTransition() {
        prune()
        if (host.shuffleEnabled) enforceShuffleOrder() else enforceLinearOrder()
    }

    /**
     * Items were added, removed or moved. With shuffle off the list order is the play order, so
     * a queued track moved by hand keeps its new place among the queued ones.
     */
    fun onPlaylistChanged() {
        prune()
        if (!host.shuffleEnabled) resortByList()
        // Additions re-randomise the shuffle order around our items; put them back next.
        // Idempotent, so our own setShuffleOrder (which lands here again) ends the loop.
        enforceShuffleOrder()
    }

    /**
     * Toggling shuffle keeps the queued tracks next in both directions. Turned on, the shuffle
     * starts at the current track, so the whole list is still ahead (as on the web).
     */
    fun onShuffleModeChanged(enabled: Boolean) {
        prune()
        if (enabled) shuffleFromCurrent() else enforceLinearOrder()
    }

    /**
     * Inserts [items] after the current item and after the earlier queued ones. Returns the
     * list index they were inserted at.
     */
    fun queueNext(items: List<T>): Int {
        if (items.isEmpty()) return -1
        prune()
        val serials = items.map { nextSerial++ }
        if (host.count == 0) {
            host.insertTagged(null, items, serials)
            pending.addAll(serials)
            prune()
            return 0
        }
        // Linear order: earlier queued items sit right after the current one, so the new ones
        // go after that block. With shuffle on the list position only matters once shuffle is
        // turned off again; the shuffle order is fixed up below.
        if (!host.shuffleEnabled) enforceLinearOrder()
        var at = host.currentIndex + 1
        while (at < host.count && host.serialAt(at) in pending) at++
        host.insertTagged(at, items, serials)
        pending.addAll(serials)
        enforceShuffleOrder()
        return at
    }

    /**
     * A new list: replaces everything but the still-queued items, which go right after [start]
     * in their play order. An empty list clears the playlist.
     */
    fun setList(items: List<T>, start: Int, positionMs: Long = 0L) {
        prune()
        val keptIdx = pendingIndices()
        val kept = keptIdx.map { host.itemAt(it) }
        val keptSerials = keptIdx.map { host.serialAt(it) }
        pending.retainAll(keptSerials.toHashSet())
        if (items.isEmpty()) {
            pending.clear()
            host.setItems(emptyList(), emptyList(), 0, 0L)
            return
        }
        val s = start.coerceIn(0, items.size - 1)
        val list = ArrayList<T>(items.size + kept.size)
        val serials = ArrayList<Long>(items.size + kept.size)
        list.addAll(items.subList(0, s + 1))
        repeat(s + 1) { serials.add(0L) }
        list.addAll(kept)
        serials.addAll(keptSerials)
        list.addAll(items.subList(s + 1, items.size))
        repeat(items.size - s - 1) { serials.add(0L) }
        host.setItems(list, serials, s, positionMs)
        shuffleFromCurrent()
    }

    /** Shuffle on: a shuffle order that starts at the current item (then the usual rules). */
    private fun shuffleFromCurrent() {
        if (!host.shuffleEnabled) return
        val order = host.shuffleOrder() ?: return
        val cur = host.currentIndex
        if (order.size != host.count || cur !in 0 until host.count) return
        val first = IntArray(order.size)
        first[0] = cur
        var k = 1
        for (i in order) if (i != cur) first[k++] = i
        val desired = QueueOrder.arrange(first, cur, pendingIndices(), autoIndices())
        if (!desired.contentEquals(order)) host.setShuffleOrder(desired)
    }

    /** Autoplay: appends [items] after everything else (shuffle never moves them). */
    fun addAutoplay(items: List<T>) {
        if (items.isEmpty()) return
        host.appendAuto(items)
        enforceShuffleOrder()
    }

    /** Autoplay items still to come (after the current one in play order). */
    fun autoAhead(): Int = upcoming().count { host.isAutoAt(it) }

    /** Removes the autoplay items still to come; returns how many went. */
    fun dropUpcomingAuto(): Int {
        val gone = upcoming().filter { host.isAutoAt(it) }.sortedDescending()
        for (i in gone) host.removeAt(i)
        return gone.size
    }

    /**
     * A user jump to [index]. Jumping to an autoplay item drops the autoplay items after it (the
     * radio continues from it); returns true then.
     */
    fun skipTo(index: Int): Boolean {
        if (index !in 0 until host.count) return false
        host.seekTo(index)
        val cur = host.currentIndex
        if (cur !in 0 until host.count || !host.isAutoAt(cur)) return false
        dropUpcomingAuto()
        return true
    }

    /** Repeat all or one turns autoplay off: the autoplay items still to come go. */
    fun onRepeatModeChanged(repeating: Boolean) {
        if (repeating) dropUpcomingAuto()
    }

    /** List indices after the current item, in play order (repeat off). */
    private fun upcoming(): List<Int> {
        val n = host.count
        val cur = host.currentIndex
        if (n == 0) return emptyList()
        if (host.shuffleEnabled) {
            val order = host.shuffleOrder()
            if (order != null && order.size == n) {
                val p = order.indexOf(cur)
                return order.toList().subList(p + 1, n)
            }
        }
        return ((cur + 1) until n).toList()
    }

    private fun autoIndices(): List<Int> = (0 until host.count).filter { host.isAutoAt(it) }

    /** Index by serial for the pending items, in [pending] order, excluding the current item. */
    private fun pendingIndices(): List<Int> {
        if (pending.isEmpty()) return emptyList()
        val bySerial = HashMap<Long, Int>()
        for (i in 0 until host.count) {
            val s = host.serialAt(i)
            if (s != 0L) bySerial[s] = i
        }
        val current = host.currentIndex
        return pending.mapNotNull { bySerial[it] }.filter { it != current }
    }

    /** Drops entries that have played (now current) or are no longer in the playlist. */
    fun prune() {
        if (pending.isEmpty()) return
        val present = HashSet<Long>()
        for (i in 0 until host.count) present.add(host.serialAt(i))
        val current = host.currentIndex
        if (current in 0 until host.count) present.remove(host.serialAt(current))
        pending.retainAll(present)
    }

    private fun resortByList() {
        if (pending.size < 2) return
        val pos = HashMap<Long, Int>()
        for (i in 0 until host.count) {
            val s = host.serialAt(i)
            if (s in pending) pos[s] = i
        }
        val sorted = pending.sortedBy { pos[it] ?: Int.MAX_VALUE }
        pending.clear()
        pending.addAll(sorted)
    }

    /**
     * Shuffle on: a shuffle order with the pending items right after the current one and the
     * autoplay items last, in list order.
     */
    private fun enforceShuffleOrder() {
        if (!host.shuffleEnabled) return
        val autos = autoIndices()
        if (pending.isEmpty() && autos.isEmpty()) return
        val order = host.shuffleOrder() ?: return
        if (order.size != host.count || order.isEmpty()) return
        val desired = QueueOrder.arrange(order, host.currentIndex, pendingIndices(), autos)
        if (!desired.contentEquals(order)) host.setShuffleOrder(desired)
    }

    /** Shuffle off: moves the pending items right after the current one in the list. */
    private fun enforceLinearOrder() {
        if (host.shuffleEnabled || pending.isEmpty()) return
        val n = host.count
        if (n == 0) return
        val linear = IntArray(n) { it }
        val desired = QueueOrder.placeNext(linear, host.currentIndex, pendingIndices())
        for ((from, to) in QueueOrder.moves(desired)) host.moveItem(from, to)
    }
}
