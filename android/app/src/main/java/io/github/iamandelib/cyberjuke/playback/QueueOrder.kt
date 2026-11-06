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

    /** Repeat all is on (Player.REPEAT_MODE_ALL). */
    val repeatAll: Boolean

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
 *   first out (or as moved with ↑ ↓, [move]), shuffle or not, until each one plays or is removed.
 *   A manual jump keeps the still-queued tracks next: they move to just after the new current
 *   track, in the order they were going to play. Jumping to a queued track plays it; the others
 *   stay next.
 * - A new list ([setList]) replaces the list and the autoplay tracks; the queued tracks stay
 *   next, in order (P1).
 * - Autoplay tracks ([addAutoplay]) play after the list in the order added; they are the list on
 *   the way, and moving on to one of them (played on to, or tapped) makes the current list start
 *   at it or at the first of them, whichever comes first in list order ([listStartIndex]; the
 *   songs before it are history; shuffled, the batch's songs before it stay ahead, and a tap brings
 *   the list's unheard songs it jumped over along, at the new list's start: [bringJumpedOver]). A
 *   radio's first suggestions join its list instead (joinList). Repeat all loops the list you're in:
 *   turning it on drops what's on the way (it comes back once repeat is off) and the songs before
 *   the current list, heard or not, keeping the playing song and the queued ones (one before it you
 *   went back to leaves once another plays, [onTransition]), and autoplay adds nothing while it is
 *   on (Stations.mayAutoplay). Turning autoplay off drops what's on the way too,
 *   never the list you're in. A jump ahead ([skipTo]) keeps what it jumps over next, and the
 *   autoplay tracks after it. The played trim leaves the current list alone. A removed marker's
 *   song hands it to the next one that stays; an Undo puts a song back in its own list: a
 *   marker's own song gets the marker back ([regain]), and shuffled, a suggestion back before one
 *   on the way goes where that list starts (starting it if it left it).
 * - Played is what was heard ([heardUids]) before the current track in play order. Shuffle turned
 *   on mixes what hasn't played of the current list: what Played shows and earlier lists stay
 *   behind, the songs you walked back over stay next, as heard, and the rest of the current list
 *   (also the items before where it started) is mixed ahead of what's on the way, mixed on its own.
 *   Off puts the mixed ones back in list order, the others where they are ([rearranged]). New
 *   autoplay tracks go at the end, mixed among themselves.
 * - Repeat all never brings back a song you queued (rule 8): when the list loops, or a tap on a
 *   "From the top" row enters the next lap, the heard ones leave ([onTransition], [skipTo]), and the
 *   loop starts at the first song that stays ([startLap]).
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

    /** The uids of the items of this list that have been current: heard ("Played" shows the ones before the current one). */
    private val heard = HashSet<Long>()
    val heardUids: Set<Long> get() = heard

    /** The uids heard in this lap: all of them until Repeat all starts the list over ([dropHeardMine]; a restored session's too). */
    private val lap = HashSet<Long>()

    /**
     * Where the current list starts and where the one on the way does, by uid (0: unset, so the
     * list starts at its first song and nothing is on the way). Removals happen outside the
     * queue (PlaybackService), so [last] remembers the list order (uid, id) to hand a gone marker
     * to the next song that stays ([onPlaylistChanged]); [listLeft] is the id of the song the list
     * start left and [nextLeft] of the last one that left the list on the way, so an Undo of one
     * stays in its list ([regain]).
     */
    private var listStart = 0L
    private var nextStart = 0L
    private var last = emptyList<Pair<Long, String>>()
    private var listLeft: String? = null
    private var nextLeft: String? = null

    /** List index of the current list's first song. */
    fun listStartIndex(): Int = indexOfUid(listStart).coerceAtLeast(0)

    /** List index of the first song of the list on the way, -1 if none. */
    fun nextStartIndex(): Int = indexOfUid(nextStart)

    private fun indexOfUid(uid: Long): Int = if (uid == 0L) -1 else (0 until host.count).firstOrNull { host.uidAt(it) == uid } ?: -1

    /** Whether making [index] current moves on: it is on the way, from its first song to the end of the list. */
    private fun movesOn(index: Int): Boolean = nextStartIndex().let { it >= 0 && index >= it }

    /**
     * Moving on to [index]: the current list starts there or at the first song on the way, whichever
     * comes first in list order (shuffled, that keeps the batch's songs before it ahead); nothing is on the way.
     */
    private fun moveOn(index: Int) {
        listStart = host.uidAt(nextStartIndex().takeIf { it in 0 until index } ?: index)
        nextStart = 0L
        listLeft = null // the lists they left are history now
        nextLeft = null
    }

    /** A marker's song went: it moves to the next one in list order that stays (none: unset). */
    private fun reanchor() {
        val live = (0 until host.count).map { host.uidAt(it) to host.idAt(it) }
        val stays = live.mapTo(HashSet()) { it.first }
        fun marker(m: Long, left: (String) -> Unit = {}): Long {
            if (m == 0L || m in stays) return m
            val k = last.indexOfFirst { it.first == m }
            if (k < 0) return 0L
            left(last[k].second)
            return last.drop(k + 1).firstOrNull { it.first in stays }?.first ?: 0L
        }
        last.dropWhile { nextStart == 0L || it.first != nextStart }.firstOrNull { it.first !in stays }?.let { nextLeft = it.second }
        listStart = marker(listStart) { listLeft = it }
        nextStart = marker(nextStart)
        last = live
    }

    /**
     * An Undo put a song back at [at]: a marker's own song (or one that left the list on the way), right
     * before the marker's song now (or last, the marker gone with it), takes it back.
     */
    private fun regain(at: Int) {
        val after = if (at + 1 < host.count) host.uidAt(at + 1) else 0L
        if (after == listStart && host.idAt(at) == listLeft) listStart = host.uidAt(at)
        if (after == nextStart && host.idAt(at) == nextLeft) nextStart = host.uidAt(at)
    }

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
        host.uidAt(index).takeIf { it != 0L }?.let { heard.add(it); lap.add(it) }
    }

    /** The current item is heard. */
    private fun hearCurrent() {
        val cur = host.currentIndex
        if (cur !in 0 until host.count) return
        hear(cur)
        if (movesOn(cur)) moveOn(cur)
    }

    /** The uid of the item current at the last transition (0: none). */
    private var lastUid = 0L

    /**
     * The current item changed (any reason): keep the pending ones right after it. [forward]: it
     * moved on (a song's end, Next, an error skip, the crossfade's hand-over). Forward to an item
     * before the last one in play order with Repeat all on is the loop: the heard songs you queued
     * leave (rule 8), and the lap starts at its first song that stays ([startLap]). Previous and a
     * tap walk back, so they stay. With Repeat all, a song from before the current list (Previous
     * took you back to it) leaves once another plays, unless you queued it (it leaves at the loop).
     */
    fun onTransition(forward: Boolean) {
        if (replacing) return
        val cur = playPos(host.currentIndex)
        val looped = forward && host.repeatAll && cur >= 0 && cur < playPos(indexOfUid(lastUid))
        if (looped) startLap()
        hearCurrent()
        if (looped) dropHeardMine()
        if (host.repeatAll) listStartIndex().let { start -> drop { it < start && host.serialAt(it) == 0L } }
        lastUid = if (host.currentIndex in 0 until host.count) host.uidAt(host.currentIndex) else 0L
        prune()
        if (host.shuffleEnabled) enforceShuffleOrder() else enforceLinearOrder()
    }

    /**
     * Items were added, removed or moved. With shuffle off the list order is the play order, so
     * a queued track moved by hand keeps its new place among the queued ones.
     */
    fun onPlaylistChanged() {
        if (replacing) return
        reanchor()
        prune()
        if (!host.shuffleEnabled) resortByList()
        // Additions re-randomise the shuffle order around our items; put them back next.
        // Idempotent, so our own setShuffleOrder (which lands here again) ends the loop.
        enforceShuffleOrder()
    }

    /**
     * Toggling shuffle keeps the queued tracks next in both directions ([rearranged], as on the web;
     * Spotify, YouTube Music). Turned on, it is a fresh shuffle (Media3 would keep the last one) of
     * what hasn't played of the current list. Turned off, the playlist moves into the same parts in
     * list order, which Media3 then plays: turning shuffle off skips none and brings no heard song
     * ahead again ([unshuffle]).
     */
    fun onShuffleModeChanged(enabled: Boolean) {
        prune()
        if (enabled) shuffleFromCurrent() else unshuffle()
    }

    /**
     * Inserts [items] after the current item and after the earlier queued ones. Returns the
     * list index they were inserted at. With nothing playing, the first one plays as a list of
     * one, without the queued-by-you mark (serial 0), and the rest are queued after it.
     */
    fun queueNext(items: List<T>): Int {
        if (items.isEmpty()) return -1
        prune()
        if (host.count == 0) {
            val serials = listOf(0L) + items.drop(1).map { nextSerial++ }
            host.insertTagged(null, items, serials)
            pending.addAll(serials.drop(1))
            return 0
        }
        val serials = items.map { nextSerial++ }
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
        listStart = 0L
        nextStart = 0L
        listLeft = null
        nextLeft = null
        if (items.isEmpty()) {
            pending.clear()
            host.setItems(emptyList(), emptyList(), 0, 0L)
            return
        }
        val s = start.coerceIn(0, items.size - 1)
        heard.clear()
        lap.clear()
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
     * [heard] ones (one flag per item, or none) are heard again; [listStart] and [nextStart] are
     * the list indices of the markers (0, -1: unset). The [mine] ones (one flag per item, or none)
     * keep the queued-by-you mark, a serial, without waiting again.
     */
    fun restoreSession(items: List<T>, sections: List<Section>, start: Int, positionMs: Long, order: IntArray?, heard: List<Boolean> = emptyList(), listStart: Int = 0, nextStart: Int = -1, mine: List<Boolean> = emptyList()) {
        require(sections.size == items.size) { "one section per item" }
        pending.clear()
        this.heard.clear()
        lap.clear()
        this.listStart = 0L
        this.nextStart = 0L
        listLeft = null
        nextLeft = null
        if (items.isEmpty()) {
            host.setItems(emptyList(), emptyList(), 0, 0L)
            return
        }
        val s = start.coerceIn(0, items.size - 1)
        val serials = sections.mapIndexed { i, sec -> if ((sec == Section.QUEUED && i != s) || mine.getOrElse(i) { false }) nextSerial++ else 0L }
        host.setItems(items, serials, s, positionMs, sections.map { it == Section.AUTO })
        this.listStart = if (listStart in 1 until items.size) host.uidAt(listStart) else 0L
        this.nextStart = if (nextStart in items.indices) host.uidAt(nextStart) else 0L
        for (i in items.indices) if (heard.getOrElse(i) { false }) hear(i)
        hearCurrent()
        if (host.shuffleEnabled && order != null && QueueOrder.isPermutation(order, items.size)) {
            host.setShuffleOrder(order)
        }
        // Only the queued ones wait: a song you queued that played and is ahead again (Previous) is a list song.
        for (i in upcoming()) if (sections[i] == Section.QUEUED) pending.add(host.serialAt(i))
        if (host.shuffleEnabled) enforceShuffleOrder() else enforceLinearOrder()
    }

    /** Shuffle on (or a new list, shuffled): a fresh shuffle order from the list order it plays in now ([rearranged]). */
    private fun shuffleFromCurrent() {
        if (!host.shuffleEnabled || host.currentIndex !in 0 until host.count) return
        host.setShuffleOrder(rearranged(IntArray(host.count) { it }, mix = true))
    }

    /**
     * Shuffle off: the playlist moves into the order [rearranged] makes from the shuffle order it had.
     * The current list then starts at its first song in that order that isn't one you queued, so none
     * of its songs falls into history.
     */
    private fun unshuffle() {
        if (host.currentIndex !in 0 until host.count) return
        val target = rearranged(host.shuffleOrder() ?: IntArray(host.count) { it }, mix = false)
        val (start, way) = listStartIndex() to nextStartIndex()
        val queued = pendingIndices()
        val first = target.firstOrNull { it >= start && (way < 0 || it < way) && it !in queued }?.let(host::uidAt)
        for ((from, to) in QueueOrder.moves(target)) host.moveItem(from, to)
        if (listStart != 0L && first != null) listStart = first
    }

    /**
     * The play order shuffle turned on or off makes from [order], the one it had (list indices). What
     * stays where it is, in the order it had: behind, what Played shows and earlier lists' songs
     * (before the current list's marker); ahead, the songs you walked back over (heard in this lap:
     * the next lap of Repeat all is all to come) and earlier lists'. Then: the current item, the queued ones
     * next, the walked-back ones, the current list's other songs (also those before where it
     * started), what's on the way; the last two each mixed on its own if [mix], else in list order.
     */
    private fun rearranged(order: IntArray, mix: Boolean): IntArray {
        val cur = host.currentIndex
        val p = order.indexOf(cur)
        val (start, way) = listStartIndex() to nextStartIndex()
        val queued = pendingIndices()
        val kept = order.filterIndexed { k, i -> i != cur && i !in queued && (i < start || if (k < p) isHeard(i) else host.uidAt(i) in lap) }
        val (behind, back) = kept.partition { order.indexOf(it) < p }
        val (onWay, list) = (0 until host.count).filter { it != cur && it !in queued && it !in kept }.partition { way >= 0 && it >= way }
        fun part(songs: List<Int>) = if (mix) songs.shuffled(random) else songs
        return (behind + cur + queued + back + part(list) + part(onWay)).toIntArray()
    }

    /**
     * Autoplay: appends [items] after everything else (shuffled: mixed among themselves). They are
     * the list on the way, unless [joinList] (a radio's first ones) or one is on the way already.
     */
    fun addAutoplay(items: List<T>, joinList: Boolean = false) {
        if (items.isEmpty()) return
        host.insertAuto(null, items)
        val n = host.count
        if (!joinList && nextStart == 0L) nextStart = host.uidAt(n - items.size)
        hearCurrent() // with nothing playing, the first one became current: it moves on
        placeAhead((n - items.size until n).toList(), null)
        enforceShuffleOrder()
    }

    /**
     * Shuffle on: Media3 puts inserted items at random places in the shuffle order, maybe behind
     * the current one. [added] go right before [anchor] if it is ahead, else at the end, mixed
     * among themselves. One of them already playing stays where it is (a batch after the end: the
     * player went on to it while it was being added).
     */
    private fun placeAhead(added: List<Int>, anchor: Int?) {
        val moving = added.filter { it != host.currentIndex }
        if (!host.shuffleEnabled || moving.isEmpty()) return
        val order = host.shuffleOrder()?.toMutableList() ?: return
        order.removeAll(moving.toSet())
        val at = anchor?.let { order.indexOf(it) }?.takeIf { it > order.indexOf(host.currentIndex) }
        if (at != null) order.addAll(at, moving) else order.addAll(moving.shuffled(random))
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
     * Undo of a removal (K3): puts [item] back as [section], right before the first item ahead
     * of the current one (play order) that has id [beforeId] (a queued item only before a queued
     * one, the others never before one); with no such item, at the end of that section (a list
     * item after the last list item ahead). It never lands at or before the current item, and a
     * queued item never lands after list items. A list item that had the queued-by-you mark
     * ([mine]: it played, then Previous brought it ahead again) gets it back (a serial, never
     * pending: it has played).
     */
    fun restore(item: T, section: Section, beforeId: String?, mine: Boolean = false) {
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
        val anchor = beforeId?.let { id -> up.firstOrNull { (sectionAt(it) == Section.QUEUED) == (section == Section.QUEUED) && host.idAt(it) == id } }
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
                // anchor, else at the very end. Shuffled, before one on the way, where that list
                // starts: it takes it back if it left it ([regain]), else it ends yours.
                val at = anchor?.let { a -> nextStartIndex().takeIf { host.shuffleEnabled && it in 0..a } ?: a }
                host.insertAuto(at, listOf(item))
                regain(at ?: (host.count - 1))
                if (at != null) placeAhead(listOf(at), anchor + 1) else placeLast(host.count - 1)
                enforceShuffleOrder()
            }
            Section.LIST -> if (!host.shuffleEnabled) {
                // Linear: [current][queued], then the list and autoplay (a tapped one among the
                // list); the end of the list part is after its last item ahead.
                val at = anchor ?: up.lastOrNull { sectionAt(it) == Section.LIST }?.plus(1) ?: afterQueuedRun()
                host.insertTagged(at, listOf(item), listOf(if (mine) nextSerial++ else 0L))
                regain(at)
            } else {
                restoreShuffledListItem(item, anchor, mine)
            }
        }
    }

    /**
     * Undo of removing a played item: back among the played, right before [beforeId] among every
     * item before the current one (play order), heard or not (a "From the top" lap moved by hand,
     * a list started mid-way), else right before the current one; a list item again, with the
     * queued-by-you mark (a serial, never pending: it has played) when it had it, [mine]. A "From
     * the top" item ([top]) the same, but unheard.
     */
    fun restorePlayed(item: T, beforeId: String?, mine: Boolean, top: Boolean = false) {
        prune()
        val cur = host.currentIndex
        if (cur !in 0 until host.count) return host.insertTagged(null, listOf(item), listOf(0L))
        val at = beforeId?.let { id -> behind().firstOrNull { host.idAt(it) == id } } ?: cur
        host.insertTagged(at, listOf(item), listOf(if (mine) nextSerial++ else 0L))
        if (!top) hear(at)
        regain(at)
        if (!host.shuffleEnabled) return
        // Inserted at a random place in the shuffle order (Media3's): right before what follows it.
        val order = host.shuffleOrder()?.toMutableList() ?: return
        order.remove(at)
        order.add(order.indexOf(at + 1), at)
        host.setShuffleOrder(QueueOrder.placeNext(order.toIntArray(), host.currentIndex, pendingIndices()))
    }

    /** Shuffle on: the list index only matters later; the shuffle order decides when it plays. */
    private fun restoreShuffledListItem(item: T, anchor: Int?, mine: Boolean) {
        // Before the first autoplay item of the list you're in (after its first song), so it stays in it.
        val at = (listStartIndex() + 1 until host.count).firstOrNull { host.isAutoAt(it) } ?: host.count
        host.insertTagged(at, listOf(item), listOf(if (mine) nextSerial++ else 0L))
        regain(at)
        val order = host.shuffleOrder() ?: return
        val anchorNow = anchor?.let { if (it >= at) it + 1 else it }
        val rest = order.filter { it != at }.toMutableList()
        val cur = host.currentIndex
        val curPos = rest.indexOf(cur)
        val pos = anchorNow?.let { rest.indexOf(it) }?.takeIf { it > curPos } ?: run {
            // After the last list item ahead, else right after the current item's queued run.
            val pend = pendingIndices().toHashSet()
            var lastList = -1
            for (k in curPos + 1 until rest.size) if (rest[k] !in pend && !host.isAutoAt(rest[k])) lastList = k
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
        // None of the current list: it starts where its marker is in list order (shuffled, its songs play in any order).
        val start = if (listStart != 0L) listStartIndex() else Int.MAX_VALUE
        val gone = played.take(played.size - keep).filter { it < start }.sortedDescending()
        for (i in gone) host.removeAt(i)
        return gone.size
    }

    /** Items still to come (after the current one in play order). */
    fun ahead(): Int = upcoming().size

    /** Removes the list on the way (its items that aren't queued): autoplay off, or repeat all. */
    fun dropOnTheWay() {
        val way = nextStartIndex()
        if (way >= 0) drop { it >= way }
        nextStart = 0L
        nextLeft = null
    }

    /** Repeat all loops the list you're in: what's on the way and the history before it go (not the playing item or the queued ones). */
    fun onRepeatModeChanged(repeatAll: Boolean) {
        if (!repeatAll) return
        dropOnTheWay()
        drop { it < listStartIndex() }
    }

    /**
     * The loop: Media3 goes to the first item in play order, which may be a heard song you queued
     * (it leaves, [dropHeardMine]). Then the first one that stays plays: that one loop isn't gapless.
     */
    private fun startLap() {
        val order = (if (host.shuffleEnabled) host.shuffleOrder() else null) ?: IntArray(host.count) { it }
        fun stays(i: Int) = host.serialAt(i) == 0L || !isHeard(i)
        if (!stays(host.currentIndex)) order.firstOrNull(::stays)?.let(host::seekTo)
    }

    /** Repeat all's next lap: the heard songs you queued leave, all but the playing one (rule 8), and only the playing one is heard this lap. */
    private fun dropHeardMine() {
        drop { host.serialAt(it) != 0L && isHeard(it) }
        lap.clear()
        if (host.currentIndex in 0 until host.count) hear(host.currentIndex)
    }

    /** Removes the items [gone] picks by list index, except the playing one and the queued ones. */
    private inline fun drop(gone: (Int) -> Boolean) {
        val out = (0 until host.count).filter { it != host.currentIndex && host.serialAt(it) !in pending && gone(it) }
        for (i in out.asReversed()) host.removeAt(i)
    }

    /**
     * A user jump to [index]. An item further ahead plays now and what it jumps over stays next
     * (YouTube Music): it moves to right after the current one first. [lap]: a tap on a "From the
     * top" row enters the next lap, so the heard songs you queued leave, as at the loop. Returns
     * true when it is an autoplay item: more follow from it, after the autoplay items still after
     * it, which stay.
     */
    fun skipTo(index: Int, lap: Boolean = false): Boolean {
        if (index !in 0 until host.count) return false
        val on = movesOn(index) // before it moves next: its place in the list is what counts
        if (on && host.shuffleEnabled) bringJumpedOver()
        val inList = index >= listStartIndex()
        val to = if (upcoming().indexOf(index) > 0) bringNext(index) else index
        // From a song before the current list (Previous took you there), a song of it moves before its first one: it starts there now.
        if (inList && to < listStartIndex()) listStart = host.uidAt(to)
        host.seekTo(to)
        if (on && nextStart != 0L) moveOn(host.currentIndex) // the transition may have moved on already
        if (lap) dropHeardMine()
        val cur = host.currentIndex
        return cur in 0 until host.count && host.isAutoAt(cur)
    }

    /**
     * Up next's ↑ ↓: moves the item at [from] to where the item at [to] is. With shuffle off the list
     * order is the play order ([onPlaylistChanged]). Shuffled, every other song keeps its place in play
     * order, and a song you queued moved past another one plays in its new place, as shuffle never mixes
     * them (rule 8): before or after it in play order, as the list may hold them elsewhere (a jump back
     * leaves them where they were).
     */
    fun move(from: Int, to: Int) {
        val order = if (host.shuffleEnabled) host.shuffleOrder() else null
        val (s, t) = host.serialAt(from) to host.serialAt(to)
        if (host.shuffleEnabled && s in pending && t in pending) {
            val queued = pending.toMutableList()
            val down = queued.indexOf(s) < queued.indexOf(t)
            queued.remove(s)
            queued.add(queued.indexOf(t) + if (down) 1 else 0, s)
            pending.clear()
            pending.addAll(queued)
        }
        host.moveItem(from, to)
        // Media3 keeps the shuffle order by index on a move (ShuffleOrder.cloneAndMove leaves it as it is): put it back by item.
        val now = { i: Int -> if (i == from) to else if (i in from..to) i - 1 else if (i in to..from) i + 1 else i }
        order?.let { o -> host.setShuffleOrder(IntArray(o.size) { now(o[it]) }) }
    }

    /**
     * Shuffled, a tap that moves on: the current list's unheard songs it jumped over come along. They
     * go just before the list on the way, which starts at them; the play order stays as it was.
     */
    private fun bringJumpedOver() {
        val way = nextStartIndex()
        val kept = (listStartIndex() until way).filter { !isHeard(it) && host.serialAt(it) !in pending }
        if (kept.isEmpty()) return
        val rest = (0 until host.count).filter { it !in kept }
        val target = (rest.take(way - kept.size) + kept + rest.drop(way - kept.size)).toIntArray()
        val (order, moves) = host.shuffleOrder() to QueueOrder.moves(target)
        for ((from, to) in moves) host.moveItem(from, to) // Media3 keeps the shuffle order by index: put it back by item
        val now = IntArray(target.size).also { for (k in target.indices) it[target[k]] = k }
        if (moves.isNotEmpty()) order?.let { o -> host.setShuffleOrder(IntArray(o.size) { now[o[it]] }) }
        nextStart = host.uidAt(way - kept.size)
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

    /** [index]'s place in the play order, -1 for none. */
    private fun playPos(index: Int): Int {
        if (index !in 0 until host.count) return -1
        return if (host.shuffleEnabled) host.shuffleOrder()?.indexOf(index) ?: index else index
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
    private fun played(): List<Int> = behind().filter(::isHeard)

    /** List indices before the current item in play order, heard or not (oldest first). */
    private fun behind(): List<Int> {
        val n = host.count
        val cur = host.currentIndex
        if (n == 0 || cur !in 0 until n) return emptyList()
        if (host.shuffleEnabled) {
            val order = host.shuffleOrder()
            if (order != null) return order.toList().subList(0, order.indexOf(cur))
        }
        return (0 until cur).toList()
    }

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
        if (heard.isNotEmpty()) (0 until host.count).map { host.uidAt(it) }.toSet().let { heard.retainAll(it); lap.retainAll(it) }
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
