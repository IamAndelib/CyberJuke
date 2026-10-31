package io.github.iamandelib.cyberjuke.playback

import kotlin.random.Random

/**
 * Pure helpers for "Add to queue" (play next, FIFO) and autoplay. No Android or Media3 types,
 * so they are unit-tested on the plain JVM (QueueOrderTest).
 */
internal object QueueOrder {

    /** [order] holds every index in 0 until [n] exactly once. */
    fun isPermutation(order: IntArray, n: Int): Boolean {
        if (order.size != n) return false
        val seen = BooleanArray(n)
        for (i in order) {
            if (i !in 0 until n || seen[i]) return false
            seen[i] = true
        }
        return true
    }

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
     * A shuffle play order with the [queued] indices right after [current] (see [placeNext]), and
     * after them the rest of what is ahead: the list, then the [auto] (autoplay) indices, each in
     * the order they have (shuffle mixes both). What is before [current] (played) stays as it is.
     * Everything else keeps its relative order; idempotent like [placeNext].
     */
    fun arrange(order: IntArray, current: Int, queued: List<Int>, auto: List<Int>): IntArray {
        val present = order.toHashSet()
        val autoSet = auto.toHashSet()
        val q = queued.filter { it != current && it in present && it !in autoSet }.toHashSet()
        val at = order.indexOf(current)
        val ahead = order.drop(at + 1).filter { it !in q }
        val seq = order.take(at + 1).filter { it !in q } +
            ahead.filter { it !in autoSet } + ahead.filter { it in autoSet } + order.filter { it in q }
        return placeNext(seq.toIntArray(), current, queued.filter { it in q })
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

    /** The item's own id, unique in the playlist and kept through moves; 0 if it has none. */
    fun uidAt(index: Int): Long

    /** The shuffle play order (every index exactly once, so its size is [count]), or null if unavailable. */
    fun shuffleOrder(): IntArray?
    fun setShuffleOrder(order: IntArray)
    fun moveItem(from: Int, to: Int)

    /** Inserts [items] at [at] (null = append), item k tagged with [serials][k]. */
    fun insertTagged(at: Int?, items: List<T>, serials: List<Long>)

    fun itemAt(index: Int): T

    /** The track id (mediaId) of the item at [index]. */
    fun idAt(index: Int): String

    /** The item at [index] was added by autoplay. */
    fun isAutoAt(index: Int): Boolean

    /**
     * Replaces the playlist ([serials] as in [insertTagged]); [start] becomes current. [auto]
     * (empty, or one flag per item) tags autoplay items, for a saved session put back.
     */
    fun setItems(items: List<T>, serials: List<Long>, start: Int, positionMs: Long, auto: List<Boolean> = emptyList())

    /** Inserts [items] tagged as autoplay at [at] (null = append). */
    fun insertAuto(at: Int?, items: List<T>)
    fun removeAt(index: Int)

    /**
     * Swaps the item at [index] for [item] (Player.replaceMediaItem). With another source Media3
     * adds it after the old one and removes the old one: it keeps its index, not its place in the
     * shuffle order, and if it was playing, playback moves on ([NativeQueue.replace] puts both back).
     */
    fun replaceAt(index: Int, item: T)

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
 * - Autoplay tracks ([addAutoplay]) play after the list in the order added. Repeat all loops what
 *   you started: a list's autoplay tracks still to come go, a single song's stay (its radio). A
 *   jump ahead ([skipTo]) keeps what it jumps over next, and the autoplay tracks after it.
 * - Played is what was heard ([heardUids]). Shuffle turned on mixes everything not heard yet, the
 *   list ahead of the autoplay tracks; the heard items stay behind, in the order they played.
 *
 * Pending items are tracked by serial (not mediaId), so the same track queued twice stays two
 * entries. [pending]'s iteration order is their play order. Not thread-safe: call it on the
 * player's thread.
 */
internal class NativeQueue<T>(private val host: QueueHost<T>, private val random: Random = Random.Default) {
    private val pending = LinkedHashSet<Long>()
    private var nextSerial = 1L

    /** Serials still waiting to play, in play order. */
    val pendingSerials: Set<Long> get() = pending

    /** The uids of the items of this list that have been current: heard, what "Played" shows. */
    private val heard = HashSet<Long>()
    val heardUids: Set<Long> get() = heard

    private fun isHeard(index: Int): Boolean = host.uidAt(index).let { it != 0L && it in heard }

    /** In [replace]: the moves Media3 makes on the way are none of the queue's business. */
    private var replacing = false

    /**
     * The same track from another source (a fresh stream link, or its manifest): it keeps its
     * place in the play order and, if it was playing, stays the one playing. Media3 alone would
     * put it anywhere in the shuffle order and move playback on to the next song ([QueueHost.replaceAt]).
     */
    fun replace(index: Int, item: T) {
        val playing = index == host.currentIndex
        val order = if (host.shuffleEnabled) host.shuffleOrder() else null
        replacing = true
        try {
            host.replaceAt(index, item)
            order?.let { if (!it.contentEquals(host.shuffleOrder())) host.setShuffleOrder(it) }
            if (playing && host.currentIndex != index) host.seekTo(index)
        } finally {
            replacing = false
        }
    }

    private fun hear(index: Int) {
        host.uidAt(index).takeIf { it != 0L }?.let { heard.add(it) }
    }

    /** The current item is heard. */
    private fun hearCurrent() {
        val cur = host.currentIndex
        if (cur in 0 until host.count) hear(cur)
    }

    /** The current item changed (any reason): keep the pending ones right after it. */
    fun onTransition() {
        if (replacing) return
        hearCurrent()
        prune()
        if (host.shuffleEnabled) enforceShuffleOrder() else enforceLinearOrder()
    }

    /**
     * Items were added, removed or moved. With shuffle off the list order is the play order, so
     * a queued track moved by hand keeps its new place among the queued ones.
     */
    fun onPlaylistChanged() {
        if (replacing) return
        prune()
        if (!host.shuffleEnabled) resortByList()
        // Additions re-randomise the shuffle order around our items; put them back next.
        // Idempotent, so our own setShuffleOrder (which lands here again) ends the loop.
        enforceShuffleOrder()
    }

    /**
     * Toggling shuffle keeps the queued tracks next in both directions. Turned on, it is a fresh
     * shuffle (Media3 would keep the last one) of everything not heard yet; what was heard stays
     * behind, in the order it played (as on the web; Spotify, YouTube Music).
     */
    fun onShuffleModeChanged(enabled: Boolean) {
        prune()
        if (enabled) shuffleFromCurrent(keepBefore = true) else enforceLinearOrder()
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
        val at = afterQueuedRun()
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
        heard.clear()
        val list = ArrayList<T>(items.size + kept.size)
        val serials = ArrayList<Long>(items.size + kept.size)
        list.addAll(items.subList(0, s + 1))
        repeat(s + 1) { serials.add(0L) }
        list.addAll(kept)
        serials.addAll(keptSerials)
        list.addAll(items.subList(s + 1, items.size))
        repeat(items.size - s - 1) { serials.add(0L) }
        host.setItems(list, serials, s, positionMs)
        hearCurrent()
        shuffleFromCurrent()
    }

    /**
     * A saved session put back (LastSession): [sections] says what each item was, [start] is
     * current at [positionMs], and the shuffle play [order] it had comes back when it still fits
     * (shuffle on). The queued items stay next, in the order they were going to play; the
     * [heard] ones (one flag per item, or none) are heard again.
     */
    fun restoreSession(items: List<T>, sections: List<Section>, start: Int, positionMs: Long, order: IntArray?, heard: List<Boolean> = emptyList()) {
        require(sections.size == items.size) { "one section per item" }
        pending.clear()
        this.heard.clear()
        if (items.isEmpty()) {
            host.setItems(emptyList(), emptyList(), 0, 0L)
            return
        }
        val s = start.coerceIn(0, items.size - 1)
        val serials = sections.mapIndexed { i, sec -> if (sec == Section.QUEUED && i != s) nextSerial++ else 0L }
        host.setItems(items, serials, s, positionMs, sections.map { it == Section.AUTO })
        for (i in items.indices) if (heard.getOrElse(i) { false }) hear(i)
        hearCurrent()
        if (host.shuffleEnabled && order != null && QueueOrder.isPermutation(order, items.size)) {
            host.setShuffleOrder(order)
        }
        for (i in upcoming()) host.serialAt(i).takeIf { it != 0L }?.let { pending.add(it) }
        if (host.shuffleEnabled) enforceShuffleOrder() else enforceLinearOrder()
    }

    /**
     * Shuffle on: a shuffle order from the current item (then the usual rules). [keepBefore]: the
     * items heard stay first, in the order they played (shuffle was off: list order), and all the
     * others are mixed ahead, also the ones before where the list started; a new list has all
     * the others ahead.
     */
    private fun shuffleFromCurrent(keepBefore: Boolean = false) {
        if (!host.shuffleEnabled) return
        val cur = host.currentIndex
        if (cur !in 0 until host.count) return
        val queued = pendingIndices().toHashSet()
        val before = if (keepBefore) (0 until host.count).filter { it != cur && it !in queued && isHeard(it) } else emptyList()
        val kept = before.toHashSet()
        val ahead = (0 until host.count).filter { it != cur && it !in kept }.shuffled(random)
        val first = (before + cur + ahead).toIntArray()
        host.setShuffleOrder(QueueOrder.arrange(first, cur, pendingIndices(), autoIndices()))
    }

    /** Autoplay: appends [items] after everything else (shuffled: among those still to come). */
    fun addAutoplay(items: List<T>) {
        if (items.isEmpty()) return
        host.insertAuto(null, items)
        val n = host.count
        placeAhead((n - items.size until n).toList(), null)
        enforceShuffleOrder()
    }

    /**
     * Shuffle on: Media3 puts inserted items at random places in the shuffle order, maybe behind
     * the current one. Each of [added] goes right before [anchor] if given, else at a random place
     * among the autoplay items still to come. One of them already playing stays where it is (a
     * batch after the end: the player went on to it while it was being added).
     */
    private fun placeAhead(added: List<Int>, anchor: Int?) {
        val moving = added.filter { it != host.currentIndex }
        if (!host.shuffleEnabled || moving.isEmpty()) return
        val order = host.shuffleOrder()?.toMutableList() ?: return
        order.removeAll(moving.toSet())
        val cur = order.indexOf(host.currentIndex)
        for (i in moving) {
            val at = anchor?.let { order.indexOf(it) }?.takeIf { it > cur } ?: run {
                var start = cur + 1
                for (k in cur + 1 until order.size) if (!host.isAutoAt(order[k])) start = k + 1
                start + random.nextInt(order.size - start + 1)
            }
            order.add(at, i)
        }
        host.setShuffleOrder(order.toIntArray())
    }

    /** The parts of Up next: queued by the user, the list, autoplay. */
    enum class Section {
        QUEUED, LIST, AUTO;

        companion object {
            /** By the web's names ('queued' | 'list' | 'autoplay'). */
            fun of(kind: String?): Section? = when (kind) {
                "queued" -> QUEUED
                "list" -> LIST
                "autoplay" -> AUTO
                else -> null
            }
        }
    }

    /**
     * Undo of a removal (K3): puts [item] back in [section], right before the first item ahead
     * of the current one (play order) that has id [beforeId] and sits in the same section; with
     * no such item, at the end of that section. It never lands at or before the current item,
     * and a queued item never lands after list items.
     */
    fun restore(item: T, section: Section, beforeId: String?) {
        prune()
        if (host.count == 0) {
            when (section) {
                Section.QUEUED -> queueNext(listOf(item))
                Section.LIST -> host.insertTagged(null, listOf(item), listOf(0L))
                Section.AUTO -> host.insertAuto(null, listOf(item))
            }
            return
        }
        if (!host.shuffleEnabled) enforceLinearOrder()
        val up = upcoming()
        val pend = pendingIndices().toHashSet()
        fun sectionAt(i: Int) = when {
            i in pend -> Section.QUEUED
            host.isAutoAt(i) -> Section.AUTO
            else -> Section.LIST
        }
        val anchor = beforeId?.let { id -> up.firstOrNull { sectionAt(it) == section && host.idAt(it) == id } }
        when (section) {
            Section.QUEUED -> {
                val serial = nextSerial++
                val at = anchor ?: afterQueuedRun()
                // The pending order is the play order: the new serial goes before the anchor's.
                val anchorSerial = anchor?.let { host.serialAt(it) }
                val order = ArrayList<Long>(pending.size + 1)
                for (sl in pending) {
                    if (sl == anchorSerial) order.add(serial)
                    order.add(sl)
                }
                if (serial !in order) order.add(serial)
                pending.clear()
                pending.addAll(order)
                host.insertTagged(at, listOf(item), listOf(serial))
                if (host.shuffleEnabled) enforceShuffleOrder() else enforceLinearOrder()
            }
            Section.AUTO -> {
                // The list index is the place in list order; with shuffle on, right before the
                // anchor, else at the very end.
                host.insertAuto(anchor, listOf(item))
                if (anchor != null) placeAhead(listOf(anchor), anchor + 1) else placeLast(host.count - 1)
                enforceShuffleOrder()
            }
            Section.LIST -> if (!host.shuffleEnabled) {
                // Linear: [current][queued][list][autoplay]; the end of the list part is the first
                // autoplay item ahead (or the end).
                val at = anchor ?: up.firstOrNull { sectionAt(it) == Section.AUTO } ?: host.count
                host.insertTagged(at, listOf(item), listOf(0L))
            } else {
                restoreShuffledListItem(item, anchor)
            }
        }
    }

    /**
     * Undo of removing a played item: back among the played, right before the played item
     * [beforeId] (play order), else right before the current one; a list item again.
     */
    fun restorePlayed(item: T, beforeId: String?) {
        prune()
        val cur = host.currentIndex
        if (cur !in 0 until host.count) return host.insertTagged(null, listOf(item), listOf(0L))
        val at = beforeId?.let { id -> played().firstOrNull { host.idAt(it) == id } } ?: cur
        host.insertTagged(at, listOf(item), listOf(0L))
        hear(at)
        if (!host.shuffleEnabled) return
        // Inserted at a random place in the shuffle order (Media3's): right before what follows it.
        val order = host.shuffleOrder()?.toMutableList() ?: return
        order.remove(at)
        order.add(order.indexOf(at + 1), at)
        host.setShuffleOrder(QueueOrder.placeNext(order.toIntArray(), host.currentIndex, pendingIndices()))
    }

    /** Shuffle on: the list index only matters later; the shuffle order decides when it plays. */
    private fun restoreShuffledListItem(item: T, anchor: Int?) {
        val at = (0 until host.count).firstOrNull { host.isAutoAt(it) } ?: host.count
        host.insertTagged(at, listOf(item), listOf(0L))
        val order = host.shuffleOrder() ?: return
        val anchorNow = anchor?.let { if (it >= at) it + 1 else it }
        val rest = order.filter { it != at }.toMutableList()
        val cur = host.currentIndex
        val curPos = rest.indexOf(cur)
        val pos = anchorNow?.let { rest.indexOf(it) }?.takeIf { it > curPos } ?: run {
            // After the last list item ahead, else right after the current item's queued run.
            val pend = pendingIndices().toHashSet()
            var lastList = -1
            for (k in curPos + 1 until rest.size) {
                val i = rest[k]
                if (i in pend) continue
                if (host.isAutoAt(i)) break
                lastList = k
            }
            if (lastList >= 0) {
                lastList + 1
            } else {
                var q = curPos + 1
                while (q < rest.size && rest[q] in pend) q++
                q
            }
        }
        rest.add(pos, at)
        val desired = QueueOrder.placeNext(rest.toIntArray(), cur, pendingIndices())
        if (!desired.contentEquals(order)) host.setShuffleOrder(desired)
    }

    /** The list index right after the current item and the queued items that follow it. */
    private fun afterQueuedRun(): Int {
        var at = host.currentIndex + 1
        while (at < host.count && host.serialAt(at) in pending) at++
        return at
    }

    /** What [removeIds] did. */
    data class Removal(val removed: Int, val stopped: Boolean)

    /**
     * Removes every item whose id is in [ids] (K5). If the current item goes, the next item in
     * play order that stays becomes current; with none, [Removal.stopped] is set (the caller
     * pauses).
     */
    fun removeIds(ids: Set<String>): Removal {
        if (ids.isEmpty() || host.count == 0) return Removal(0, false)
        prune()
        var stopped = false
        val cur = host.currentIndex
        if (cur in 0 until host.count && host.idAt(cur) in ids) {
            val next = upcoming().firstOrNull { host.idAt(it) !in ids }
            if (next != null) host.seekTo(next) else stopped = true
        }
        // A jump moves queued items (onTransition): look the indices up again.
        val gone = (0 until host.count).filter { host.idAt(it) in ids }.sortedDescending()
        for (i in gone) host.removeAt(i)
        prune()
        return Removal(gone.size, stopped)
    }

    /**
     * Keeps at most [keep] played autoplay items behind the current one (a long radio session
     * would otherwise grow forever); removes the oldest. Returns how many went.
     */
    fun trimPlayedAuto(keep: Int): Int {
        val played = played().filter { host.isAutoAt(it) }
        if (played.size <= keep) return 0
        val gone = played.take(played.size - keep).sortedDescending()
        for (i in gone) host.removeAt(i)
        return gone.size
    }

    /** Items still to come (after the current one in play order). */
    fun ahead(): Int = upcoming().size

    /** Removes the autoplay items still to come; returns how many went. */
    fun dropUpcomingAuto(): Int {
        val gone = upcoming().filter { host.isAutoAt(it) }.sortedDescending()
        for (i in gone) host.removeAt(i)
        return gone.size
    }

    /**
     * Repeat all loops what you started: a list's autoplay items still to come go (they come back
     * once repeat is off); a single song's are its radio, the loop itself, and stay.
     */
    fun onRepeatModeChanged(repeatAll: Boolean) {
        if (repeatAll && (0 until host.count).count { !host.isAutoAt(it) } > 1) dropUpcomingAuto()
    }

    /**
     * A user jump to [index]. An item further ahead plays now and what it jumps over stays next
     * (YouTube Music): it moves to right after the current one first. Returns true when it is an
     * autoplay item: more follow from it, after the autoplay items still after it, which stay.
     */
    fun skipTo(index: Int): Boolean {
        if (index !in 0 until host.count) return false
        host.seekTo(if (upcoming().indexOf(index) > 0) bringNext(index) else index)
        val cur = host.currentIndex
        return cur in 0 until host.count && host.isAutoAt(cur)
    }

    /** Shuffle on: [index] plays last. */
    private fun placeLast(index: Int) {
        if (!host.shuffleEnabled) return
        val order = host.shuffleOrder()?.toMutableList() ?: return
        if (!order.remove(index)) return
        order.add(index)
        host.setShuffleOrder(order.toIntArray())
    }

    /** Moves [index] to play right after the current item; returns where it is now. */
    private fun bringNext(index: Int): Int {
        val cur = host.currentIndex
        if (!host.shuffleEnabled) {
            host.moveItem(index, cur + 1)
            return cur + 1
        }
        val order = host.shuffleOrder()?.toMutableList() ?: return index
        order.remove(index)
        order.add(order.indexOf(cur) + 1, index)
        host.setShuffleOrder(order.toIntArray())
        return index
    }

    /** List indices after the current item, in play order (repeat off). */
    private fun upcoming(): List<Int> {
        val n = host.count
        val cur = host.currentIndex
        if (n == 0) return emptyList()
        if (host.shuffleEnabled) {
            val order = host.shuffleOrder()
            if (order != null) {
                val p = order.indexOf(cur)
                return order.toList().subList(p + 1, n)
            }
        }
        return ((cur + 1) until n).toList()
    }

    /** List indices before the current item in play order that were heard (oldest first). */
    private fun played(): List<Int> {
        val n = host.count
        val cur = host.currentIndex
        if (n == 0 || cur !in 0 until n) return emptyList()
        if (host.shuffleEnabled) {
            val order = host.shuffleOrder()
            if (order != null) return order.toList().subList(0, order.indexOf(cur)).filter(::isHeard)
        }
        return (0 until cur).filter(::isHeard)
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
        if (heard.isNotEmpty()) heard.retainAll((0 until host.count).map { host.uidAt(it) }.toSet())
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
     * Shuffle on: the pending items right after the current one; the rest keeps its order (the
     * list before autoplay is set when shuffle is turned on, [shuffleFromCurrent], and by where
     * each insert goes). As on the web: a jump back leaves what is ahead as it was.
     */
    private fun enforceShuffleOrder() {
        if (!host.shuffleEnabled || pending.isEmpty()) return
        val order = host.shuffleOrder() ?: return
        val desired = QueueOrder.placeNext(order, host.currentIndex, pendingIndices())
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
