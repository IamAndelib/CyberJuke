package io.github.iamandelib.cyberjuke.playback

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Random
import kotlin.random.asKotlinRandom

/**
 * Runs the shared queue rule table (tests/spec/queue-rules.json, also run against the
 * web Queue by src/player/queueRules.test.ts) against [NativeQueue], on a fake player that
 * reproduces the ExoPlayer behaviour PlaybackService relies on: index shifts, shuffle orders
 * that place inserted or moved items at random, repeat modes for auto and user navigation,
 * seekToPrevious's 3 s rule, and listener events delivered after each operation.
 */
class QueueRulesTest {

    @Test
    fun sharedRuleTable() {
        val spec = JSONObject(specFile().readText())
        val cases = spec.getJSONArray("cases")
        assertTrue(cases.length() > 0)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            // Shuffled cases (shuffle on at the start or turned on later) only check sets and
            // leading ids; run them with several seeds.
            val steps = c.getJSONArray("steps")
            val shuffles = c.optBoolean("shuffle", false) || (0 until steps.length()).any { steps.getJSONObject(it).getString("op") == "setShuffle" }
            val seeds = if (shuffles) 0L until 25L else 0L until 1L
            for (seed in seeds) runCase(c, seed)
        }
    }

    private fun specFile(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val f = File(dir, "tests/spec/queue-rules.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        throw IllegalStateException("tests/spec/queue-rules.json not found above ${System.getProperty("user.dir")}")
    }

    private fun runCase(c: JSONObject, seed: Long) {
        val name = c.getString("name")
        val p = FakePlayer(Random(seed))
        p.repeat = c.optString("repeat", "off")
        p.shuffle = c.optBoolean("shuffle", false)
        // Like the app: the first list goes through the queue too (shuffle starts at the track).
        p.queue.setList(strings(c.getJSONArray("list")), c.optInt("start", 0))
        val steps = c.getJSONArray("steps")
        var undo: Undo? = null
        var top = emptyList<String>()
        for (k in 0 until steps.length()) {
            val s = steps.getJSONObject(k)
            val where = "'$name' (seed $seed) step $k ${s.getString("op")}"
            when (s.getString("op")) {
                "setList" -> p.queue.setList(strings(s.getJSONArray("ids")), s.optInt("start", 0))
                "queueNext" -> p.queue.queueNext(strings(s.getJSONArray("ids")))
                "addAuto" -> p.queue.addAutoplay(strings(s.getJSONArray("ids")), s.optBoolean("joinList", false))
                "restore" -> restore(
                    p,
                    Undo(s.getString("id"), s.getString("kind"), if (s.isNull("beforeId")) null else s.getString("beforeId"), s.optInt("beforeIndex", -1), s.optBoolean("mine", false), s.optBoolean("auto", false), s.optBoolean("heard", false), s.optBoolean("earlier", false)),
                    where,
                )
                "removeRow" -> {
                    undo = undoOf(p, s.getString("id"), s.optString("from"))
                    p.queue.remove(p.ids.indexOf(s.getString("id")))
                }
                "undo" -> restore(p, undo!!, where)
                "removeIds" -> p.queue.removeIds(strings(s.getJSONArray("ids")).toSet())
                "dropOnTheWay" -> p.queue.dropOnTheWay()
                "skipTo" -> p.queue.skipTo(p.ids.indexOf(s.getString("id")), s.optBoolean("lap", false))
                // The next lap ("From the top"): the play order from its first song to the current one, without the songs you queued.
                "keepTop" -> top = (p.played() + p.ids[p.current]).filter { p.serials[p.ids.indexOf(it)] == 0L }
                "next" -> p.next()
                "nextAuto" -> p.nextAuto()
                "prev" -> p.prev(s.optLong("positionMs", 0L))
                "remove" -> p.queue.remove(p.ids.withIndex().filter { it.value == s.getString("id") }[s.optInt("nth", 0)].index)
                "move" -> p.queue.move(p.ids.indexOf(s.getString("id")), if (s.has("toId")) p.ids.indexOf(s.getString("toId")) else s.getInt("to"))
                "setShuffle" -> p.toggleShuffle(s.getBoolean("on"))
                "setRepeat" -> {
                    p.repeat = s.getString("mode")
                    p.queue.onRepeatModeChanged(p.repeat == "all")
                }
                "expect" -> expect(p, s, where, top)
                else -> throw IllegalArgumentException("unknown op in $where")
            }
        }
    }

    private fun expect(p: FakePlayer, s: JSONObject, where: String, top: List<String>) {
        val up = p.upNext()
        if (s.has("current")) {
            val want = if (s.isNull("current")) null else s.getString("current")
            assertEquals("current in $where", want, p.ids.getOrNull(p.current))
        }
        if (s.has("upNext")) assertEquals("upNext in $where", strings(s.getJSONArray("upNext")), up)
        if (s.has("upNextBlocks")) {
            // Each block's songs in any order (a shuffled block); the blocks in order.
            var at = 0
            for (b in s.getJSONArray("upNextBlocks").let { a -> (0 until a.length()).map { strings(a.getJSONArray(it)) } }) {
                assertEquals("upNextBlocks in $where (got $up)", b.sorted(), up.drop(at).take(b.size).sorted())
                at += b.size
            }
            assertEquals("upNextBlocks length in $where (got $up)", at, up.size)
        }
        if (s.has("upNextStartsWith")) {
            val want = strings(s.getJSONArray("upNextStartsWith"))
            assertEquals("upNextStartsWith in $where (got $up)", want, up.take(want.size))
        }
        if (s.has("listStart")) assertEquals("listStart in $where", s.getString("listStart"), p.ids[p.queue.listStartIndex()])
        if (s.has("queued")) {
            val pending = p.queue.pendingSerials
            val queued = up.takeWhile { p.serials[p.ids.indexOf(it)] in pending }.size
            assertEquals("queued in $where", s.getInt("queued"), queued)
        }
        if (s.has("list")) assertEquals("list in $where", strings(s.getJSONArray("list")), p.ids.toList())
        if (s.has("played")) assertEquals("played in $where", strings(s.getJSONArray("played")), p.played())
        if (s.has("mine")) assertEquals("mine in $where", strings(s.getJSONArray("mine")), p.ids.filterIndexed { i, _ -> p.serials[i] != 0L })
        if (s.has("heardMine")) {
            val want = s.getJSONArray("heardMine").let { a -> (0 until a.length()).map { strings(a.getJSONArray(it)) } }
            assertEquals("heardMine in $where", want, p.queue.heardMine.map { listOf(it.id, it.after) })
        }
        if (s.has("upNextIsKeptTop")) assertEquals("upNextIsKeptTop in $where", top, listOf(p.ids[p.current]) + up)
        if (s.has("top")) assertEquals("top in $where", strings(s.getJSONArray("top")), p.top())
        if (s.has("topSet")) assertEquals("topSet in $where", strings(s.getJSONArray("topSet")).sorted(), p.top().sorted())
        val (lead, list, autos) = sections(p).map { it.second }
        if (s.has("queuedIds")) assertEquals("queuedIds in $where", strings(s.getJSONArray("queuedIds")), lead)
        if (s.has("listIds")) assertEquals("listIds in $where", strings(s.getJSONArray("listIds")), list)
        if (s.has("listSet")) assertEquals("listSet in $where", strings(s.getJSONArray("listSet")).sorted(), list.sorted())
        if (s.has("autoplayIds")) assertEquals("autoplayIds in $where", strings(s.getJSONArray("autoplayIds")), autos)
        if (s.has("autoplaySet")) assertEquals("autoplaySet in $where", strings(s.getJSONArray("autoplaySet")).sorted(), autos.sorted())
    }

    /** Up next's sections (the page's sectionsOf): each row by the kind StateEncoder sends for it, in play order. */
    private fun sections(p: FakePlayer): List<Pair<String, List<String>>> {
        val kinds = p.upNext().groupBy {
            val i = p.ids.indexOf(it)
            if (p.serials[i] in p.queue.pendingSerials) "queued" else if (p.auto[i]) "autoplay" else "list"
        }
        return listOf("queued", "list", "autoplay").map { it to kinds[it].orEmpty() }
    }

    private fun strings(a: JSONArray) = (0 until a.length()).map { a.getString(it) }

    /** What a row's ✕ keeps for its Undo (the page's Undo): its kind, the song after it in play order and that one's index once it is gone, its mark, tag and heard state, and whether it is of an earlier list. */
    private data class Undo(val id: String, val kind: String, val before: String?, val beforeIndex: Int, val mine: Boolean, val auto: Boolean, val heard: Boolean, val earlier: Boolean)

    /** PlaybackService's ACTION_RESTORE. */
    private fun restore(p: FakePlayer, u: Undo, where: String) {
        if (u.kind == QueueCommands.KIND_PLAYED || u.kind == QueueCommands.KIND_TOP) {
            p.queue.restorePlayed(u.id, u.before, u.mine, u.kind == QueueCommands.KIND_TOP, u.beforeIndex, u.auto, u.earlier)
        } else {
            p.queue.restore(u.id, NativeQueue.Section.of(u.kind) ?: throw IllegalArgumentException("kind in $where"), u.before, u.mine, u.beforeIndex, u.auto, u.heard, u.earlier)
        }
    }

    /**
     * ✕ on the row of [id] in Up next (or in Played, or "From the top": [from]), as the page's undoOf keeps its
     * Undo from the state StateEncoder sends: a suggestion of the list you're in goes back into it, and a
     * Played or "From the top" row before the song after it in play order, heard or not.
     */
    private fun undoOf(p: FakePlayer, id: String, from: String): Undo {
        val (played, lap, up) = Triple(p.played(), p.top(), p.upNext())
        val rows = when (from) {
            "played" -> played
            "top" -> lap
            else -> up
        }
        val i = p.ids.indexOf(id)
        val heard = from == "played" || id in played || p.uids[i] in p.queue.lapUids
        val next = if (from == "played" || from == "top") behindAfter(p, played, lap, id) else rows.getOrNull(rows.indexOf(id) + 1)
        val way = p.queue.nextStartIndex()
        val kind = when {
            from == "top" && heard -> "played"
            from.isNotEmpty() -> from
            else -> sections(p).first { id in it.second }.first.let { if (it == "autoplay" && !(way >= 0 && i >= way)) "list" else it }
        }
        val at = next?.let { p.ids.indexOf(it) }?.let { if (it > i) it - 1 else it } ?: -1
        return Undo(id, kind, next, at, p.serials[i] != 0L, p.auto[i], heard, i < p.queue.listStartIndex())
    }

    /** The song after [id] in play order behind the current one: Played shows the heard ones, "From the top" all but the songs you queued (the page's behindAfter). */
    private fun behindAfter(f: FakePlayer, played: List<String>, lap: List<String>, id: String): String? {
        fun after(rows: List<String>) = rows.indexOf(id).takeIf { it >= 0 }?.let { rows.getOrNull(it + 1) }
        val (p, l) = after(played) to after(lap)
        if (p != null && l != null && !f.shuffle) return if (f.ids.indexOf(p) < f.ids.indexOf(l)) p else l
        return if (p != null && p !in lap) p else l ?: p
    }

    /** Just enough ExoPlayer for the queue logic; ids are unique within a case. */
    internal class FakePlayer(private val rnd: Random) : QueueHost<String> {
        val ids = ArrayList<String>()
        val serials = ArrayList<Long>()
        val auto = ArrayList<Boolean>()
        val uids = ArrayList<Long>()
        private var nextUid = 1L
        var current = -1
        var shuffle = false
        var repeat = "off"
        private var order = ArrayList<Int>() // shuffle play order
        val queue = NativeQueue(this, rnd.asKotlinRandom())

        private val events = ArrayDeque<() -> Unit>()
        private var dispatching = false

        /** Listener callbacks run after the operation; ones raised inside a callback queue up. */
        private fun emit(vararg e: () -> Unit) {
            events.addAll(e)
            if (dispatching) return
            dispatching = true
            try {
                while (events.isNotEmpty()) events.removeFirst()()
            } finally {
                dispatching = false
            }
        }

        /** The list played to its end (PlaybackService: ENDED). */
        var ended = false

        /** After the queue saw a timeline change (PlaybackService.onTimelineChanged's own work). */
        var onTimeline: (() -> Unit)? = null

        private val timelineChanged: () -> Unit = {
            queue.onPlaylistChanged()
            onTimeline?.invoke()
        }
        /** The current item changed; [forward]: a Next or a song's end (PlaybackService: a forward move). */
        private fun transition(forward: Boolean = false): () -> Unit = { queue.onTransition(forward) }

        // ---- QueueHost ----
        override val count get() = ids.size
        override val currentIndex get() = current
        override val shuffleEnabled get() = shuffle
        override val repeatAll get() = repeat == "all"
        override fun serialAt(index: Int) = serials[index]
        override fun uidAt(index: Int) = uids[index]
        private fun newUids(n: Int) = List(n) { nextUid++ }
        override fun shuffleOrder(): IntArray = order.toIntArray()

        override fun setShuffleOrder(order: IntArray) {
            this.order = ArrayList(order.toList())
            emit(timelineChanged)
        }

        override fun moveItem(from: Int, to: Int) {
            ids.add(to, ids.removeAt(from))
            serials.add(to, serials.removeAt(from))
            auto.add(to, auto.removeAt(from))
            uids.add(to, uids.removeAt(from))
            current = when {
                current == from -> to
                current in (from + 1)..to -> current - 1
                current in to until from -> current + 1
                else -> current
            }
            // Media3 keeps the shuffle order by index (ShuffleOrder.cloneAndMove leaves it as it is), so the songs moved past change places in it.
            emit(timelineChanged)
        }

        override fun insertTagged(at: Int?, items: List<String>, serials: List<Long>) {
            val pos = at ?: ids.size
            ids.addAll(pos, items)
            this.serials.addAll(pos, serials)
            auto.addAll(pos, items.map { false })
            uids.addAll(pos, newUids(items.size))
            orderInsert(pos, items.size)
            if (current < 0) {
                current = 0
                emit(timelineChanged, transition())
                return
            }
            if (pos <= current) current += items.size
            emit(timelineChanged)
        }

        override fun itemAt(index: Int) = ids[index]
        override fun idAt(index: Int) = ids[index]
        override fun isAutoAt(index: Int) = auto[index]

        override fun setItems(items: List<String>, serials: List<Long>, start: Int, positionMs: Long, auto: List<Boolean>) {
            ids.clear()
            this.serials.clear()
            this.auto.clear()
            uids.clear()
            uids.addAll(newUids(items.size))
            ids.addAll(items)
            this.serials.addAll(serials)
            items.indices.forEach { this.auto.add(auto.getOrElse(it) { false }) }
            order = ArrayList((items.indices).toList().shuffled(rnd))
            current = if (items.isEmpty()) -1 else start.coerceIn(0, items.size - 1)
            emit(timelineChanged, transition())
        }

        override fun insertAuto(at: Int?, items: List<String>) {
            val pos = at ?: ids.size
            ids.addAll(pos, items)
            serials.addAll(pos, items.map { 0L })
            auto.addAll(pos, items.map { true })
            uids.addAll(pos, newUids(items.size))
            orderInsert(pos, items.size)
            if (current < 0) {
                current = 0
                emit(timelineChanged, transition())
                return
            }
            if (pos <= current) current += items.size
            emit(timelineChanged)
        }

        override fun removeAt(index: Int) = remove(index)

        /**
         * Media3's replaceMediaItem with another source: it adds the item after the old one and
         * removes the old one (ExoPlayerImpl.replaceMediaItems). The item keeps its index and uid
         * (buildUpon keeps the extras), not its place in the shuffle order, and if it was playing,
         * playback moves on to what comes after it in the play order with the new item in it:
         * the new item itself in list order, anything with shuffle on.
         */
        override fun replaceAt(index: Int, item: String) {
            require(index in ids.indices)
            val playing = index == current
            ids.add(index + 1, item)
            serials.add(index + 1, serials[index])
            auto.add(index + 1, auto[index])
            uids.add(index + 1, uids[index])
            orderInsert(index + 1, 1)
            if (current > index) current++
            // The removed current one's successor, in the play order with the new item in it.
            var next = if (playing) nextIndex(current, "off") else -1
            if (next > index) next--
            if (!playing && current > index) current--
            ids.removeAt(index)
            serials.removeAt(index)
            auto.removeAt(index)
            uids.removeAt(index)
            orderRemove(index)
            if (playing) current = if (next >= 0) next else index.coerceAtMost(ids.size - 1)
            if (playing && current != index) emit(timelineChanged, transition()) else emit(timelineChanged)
        }

        // ---- ExoPlayer shuffle order bookkeeping (DefaultShuffleOrder) ----
        private fun orderInsert(at: Int, n: Int) {
            for (k in order.indices) if (order[k] >= at) order[k] += n
            for (i in at until at + n) order.add(rnd.nextInt(order.size + 1), i)
        }

        private fun orderRemove(index: Int) {
            order.remove(index)
            for (k in order.indices) if (order[k] > index) order[k] -= 1
        }

        // ---- player operations ----
        override fun seekTo(index: Int) = moveTo(index, forward = false)

        /** Player.seekTo; [forward]: a Next (PlaybackService tells the queue it moved forward). */
        private fun moveTo(index: Int, forward: Boolean) {
            require(index in ids.indices)
            if (index == current) return
            current = index
            ended = false
            emit(transition(forward))
        }

        private fun playOrder(): List<Int> = if (shuffle) order else ids.indices.toList()

        private fun nextIndex(i: Int, rep: String): Int {
            val seq = playOrder()
            val pos = seq.indexOf(i)
            return when {
                pos + 1 < seq.size -> seq[pos + 1]
                rep == "all" && seq.isNotEmpty() -> seq[0]
                else -> -1
            }
        }

        private fun previousIndex(i: Int, rep: String): Int {
            val seq = playOrder()
            val pos = seq.indexOf(i)
            return when {
                pos > 0 -> seq[pos - 1]
                rep == "all" && seq.isNotEmpty() -> seq.last()
                else -> -1
            }
        }

        /** User navigation treats repeat-one as off (Player.seekToNext / seekToPrevious). */
        private val navRepeat get() = if (repeat == "one") "off" else repeat

        /** JukePlayerPlugin.skipToNext: Media3's (repeat one as off). */
        fun next() {
            val n = nextIndex(current, navRepeat)
            if (n >= 0) moveTo(n, forward = true)
        }

        fun nextAuto() {
            if (repeat == "one") {
                emit(transition()) // MEDIA_ITEM_TRANSITION_REASON_REPEAT
                return
            }
            val n = nextIndex(current, repeat)
            if (n < 0) {
                ended = true
                return
            }
            current = n
            emit(transition(forward = true))
        }

        fun prev(positionMs: Long) {
            val p = previousIndex(current, navRepeat)
            if (p >= 0 && positionMs <= 3000L) seekTo(p) // else: restart the current track
        }

        /**
         * Media3's removal: the playing item removed hands on to the next one in play order, else to the first one in
         * play order, ended (ExoPlayerImpl.getPeriodPositionUsAfterTimelineChanged: getFirstWindowIndex(shuffle)).
         */
        fun remove(index: Int) {
            require(index in ids.indices)
            val changed = index == current
            val seq = playOrder()
            val next = if (changed) seq.getOrNull(seq.indexOf(index) + 1) ?: seq.firstOrNull { it != index } ?: -1 else current
            ids.removeAt(index)
            serials.removeAt(index)
            auto.removeAt(index)
            uids.removeAt(index)
            orderRemove(index)
            current = if (next > index) next - 1 else next
            if (changed) emit(timelineChanged, transition()) else emit(timelineChanged)
        }

        fun toggleShuffle(on: Boolean) {
            if (on == shuffle) return
            shuffle = on
            emit({ queue.onShuffleModeChanged(on) })
        }

        /** What played, oldest first: StateEncoder's walk back from the current item (repeat off), heard ones only. */
        fun played(): List<String> {
            if (current < 0) return emptyList()
            val seq = playOrder()
            return seq.subList(0, seq.indexOf(current)).filter { uids[it] in queue.heardUids }.map { ids[it] }
        }

        /** The next lap ("From the top"): StateEncoder's walk from the first item in play order to the current one, repeat all only, without the songs you queued. */
        fun top(): List<String> {
            val out = ArrayList<String>()
            if (current < 0 || repeat != "all") return out
            var i = playOrder().first()
            while (i >= 0 && i != current && out.size < 50) {
                if (serials[i] == 0L) out.add(ids[i])
                i = nextIndex(i, "off")
            }
            return out
        }

        /** Same walk as StateEncoder (to the end of the play order, whatever the repeat mode). */
        fun upNext(): List<String> {
            val out = ArrayList<String>()
            if (current < 0) return out
            var i = nextIndex(current, "off")
            while (i >= 0 && i != current && out.size < 50) {
                out.add(ids[i])
                i = nextIndex(i, "off")
            }
            return out
        }
    }
}
