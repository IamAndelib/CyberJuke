package io.github.iamandelib.cyberjuke.playback

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Random

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
            // Shuffled cases only check the leading ids; run them with several seeds.
            val seeds = if (c.optBoolean("shuffle", false)) 0L until 25L else 0L until 1L
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
        for (k in 0 until steps.length()) {
            val s = steps.getJSONObject(k)
            val where = "'$name' (seed $seed) step $k ${s.getString("op")}"
            when (s.getString("op")) {
                "setList" -> p.queue.setList(strings(s.getJSONArray("ids")), s.optInt("start", 0))
                "queueNext" -> p.queue.queueNext(strings(s.getJSONArray("ids")))
                "addAuto" -> p.queue.addAutoplay(strings(s.getJSONArray("ids")))
                "restore" -> p.queue.restore(
                    s.getString("id"),
                    NativeQueue.Section.of(s.getString("kind")) ?: throw IllegalArgumentException("kind in $where"),
                    if (s.isNull("beforeId")) null else s.getString("beforeId"),
                )
                "removeIds" -> p.queue.removeIds(strings(s.getJSONArray("ids")).toSet())
                "skipTo" -> p.queue.skipTo(p.ids.indexOf(s.getString("id")))
                "next" -> p.next()
                "nextAuto" -> p.nextAuto()
                "prev" -> p.prev(s.optLong("positionMs", 0L))
                "remove" -> p.remove(p.ids.indexOf(s.getString("id")))
                "move" -> p.moveItem(p.ids.indexOf(s.getString("id")), s.getInt("to"))
                "setShuffle" -> p.toggleShuffle(s.getBoolean("on"))
                "setRepeat" -> {
                    p.repeat = s.getString("mode")
                    p.queue.onRepeatModeChanged(p.repeat != "off")
                }
                "expect" -> expect(p, s, where)
                else -> throw IllegalArgumentException("unknown op in $where")
            }
        }
    }

    private fun expect(p: FakePlayer, s: JSONObject, where: String) {
        val up = p.upNext()
        if (s.has("current")) {
            val want = if (s.isNull("current")) null else s.getString("current")
            assertEquals("current in $where", want, p.ids.getOrNull(p.current))
        }
        if (s.has("upNext")) assertEquals("upNext in $where", strings(s.getJSONArray("upNext")), up)
        if (s.has("upNextStartsWith")) {
            val want = strings(s.getJSONArray("upNextStartsWith"))
            assertEquals("upNextStartsWith in $where (got $up)", want, up.take(want.size))
        }
        if (s.has("queued")) {
            val pending = p.queue.pendingSerials
            val queued = up.takeWhile { p.serials[p.ids.indexOf(it)] in pending }.size
            assertEquals("queued in $where", s.getInt("queued"), queued)
        }
        if (s.has("list")) assertEquals("list in $where", strings(s.getJSONArray("list")), p.ids.toList())
        // Up next's sections: the leading queued run, then list and autoplay by tag.
        val lead = up.takeWhile { p.serials[p.ids.indexOf(it)] in p.queue.pendingSerials }
        val after = up.drop(lead.size)
        val autos = after.filter { p.auto[p.ids.indexOf(it)] }
        val list = after.filter { !p.auto[p.ids.indexOf(it)] }
        if (s.has("queuedIds")) assertEquals("queuedIds in $where", strings(s.getJSONArray("queuedIds")), lead)
        if (s.has("listIds")) assertEquals("listIds in $where", strings(s.getJSONArray("listIds")), list)
        if (s.has("listSet")) assertEquals("listSet in $where", strings(s.getJSONArray("listSet")).sorted(), list.sorted())
        if (s.has("autoplayIds")) assertEquals("autoplayIds in $where", strings(s.getJSONArray("autoplayIds")), autos)
    }

    private fun strings(a: JSONArray) = (0 until a.length()).map { a.getString(it) }

    /** Just enough ExoPlayer for the queue logic; ids are unique within a case. */
    internal class FakePlayer(private val rnd: Random) : QueueHost<String> {
        val ids = ArrayList<String>()
        val serials = ArrayList<Long>()
        val auto = ArrayList<Boolean>()
        var current = -1
        var shuffle = false
        var repeat = "off"
        private var order = ArrayList<Int>() // shuffle play order
        val queue = NativeQueue(this)

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

        private val timelineChanged: () -> Unit = { queue.onPlaylistChanged() }
        private val transition: () -> Unit = { queue.onTransition() }

        // ---- QueueHost ----
        override val count get() = ids.size
        override val currentIndex get() = current
        override val shuffleEnabled get() = shuffle
        override fun serialAt(index: Int) = serials[index]
        override fun shuffleOrder(): IntArray = order.toIntArray()

        override fun setShuffleOrder(order: IntArray) {
            this.order = ArrayList(order.toList())
            emit(timelineChanged)
        }

        override fun moveItem(from: Int, to: Int) {
            ids.add(to, ids.removeAt(from))
            serials.add(to, serials.removeAt(from))
            auto.add(to, auto.removeAt(from))
            current = when {
                current == from -> to
                current in (from + 1)..to -> current - 1
                current in to until from -> current + 1
                else -> current
            }
            orderRemove(from)
            orderInsert(to, 1)
            emit(timelineChanged)
        }

        override fun insertTagged(at: Int?, items: List<String>, serials: List<Long>) {
            val pos = at ?: ids.size
            ids.addAll(pos, items)
            this.serials.addAll(pos, serials)
            auto.addAll(pos, items.map { false })
            orderInsert(pos, items.size)
            if (current < 0) {
                current = 0
                emit(timelineChanged, transition)
                return
            }
            if (pos <= current) current += items.size
            emit(timelineChanged)
        }

        override fun itemAt(index: Int) = ids[index]
        override fun idAt(index: Int) = ids[index]
        override fun isAutoAt(index: Int) = auto[index]

        override fun setItems(items: List<String>, serials: List<Long>, start: Int, positionMs: Long) {
            ids.clear()
            this.serials.clear()
            auto.clear()
            ids.addAll(items)
            this.serials.addAll(serials)
            items.forEach { auto.add(false) }
            order = ArrayList((items.indices).toList().shuffled(rnd))
            current = if (items.isEmpty()) -1 else start.coerceIn(0, items.size - 1)
            emit(timelineChanged, transition)
        }

        override fun insertAuto(at: Int?, items: List<String>) {
            val pos = at ?: ids.size
            ids.addAll(pos, items)
            serials.addAll(pos, items.map { 0L })
            auto.addAll(pos, items.map { true })
            orderInsert(pos, items.size)
            if (current < 0) {
                current = 0
                emit(timelineChanged, transition)
                return
            }
            if (pos <= current) current += items.size
            emit(timelineChanged)
        }

        override fun removeAt(index: Int) = remove(index)

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
        override fun seekTo(index: Int) {
            require(index in ids.indices)
            if (index == current) return
            current = index
            emit(transition)
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

        fun next() {
            val n = nextIndex(current, navRepeat)
            if (n >= 0) seekTo(n)
        }

        fun nextAuto() {
            if (repeat == "one") {
                emit(transition) // MEDIA_ITEM_TRANSITION_REASON_REPEAT
                return
            }
            val n = nextIndex(current, repeat)
            if (n < 0) return // ended
            current = n
            emit(transition)
        }

        fun prev(positionMs: Long) {
            val p = previousIndex(current, navRepeat)
            if (p >= 0 && positionMs <= 3000L) seekTo(p) // else: restart the current track
        }

        fun remove(index: Int) {
            require(index in ids.indices)
            ids.removeAt(index)
            serials.removeAt(index)
            auto.removeAt(index)
            orderRemove(index)
            val changed = index == current
            if (index < current) current--
            if (current >= ids.size) current = ids.size - 1
            if (changed) emit(timelineChanged, transition) else emit(timelineChanged)
        }

        fun toggleShuffle(on: Boolean) {
            if (on == shuffle) return
            shuffle = on
            emit({ queue.onShuffleModeChanged(on) })
        }

        /** Same walk as JukePlayerPlugin.buildState (repeat-one shown as off). */
        fun upNext(): List<String> {
            val out = ArrayList<String>()
            if (current < 0) return out
            var i = nextIndex(current, navRepeat)
            while (i >= 0 && i != current && out.size < 50) {
                out.add(ids[i])
                i = nextIndex(i, navRepeat)
            }
            return out
        }
    }
}
