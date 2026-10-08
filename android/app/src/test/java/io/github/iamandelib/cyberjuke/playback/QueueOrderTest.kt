package io.github.iamandelib.cyberjuke.player

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class QueueOrderTest {

    private fun apply(n: Int, moves: List<Pair<Int, Int>>): IntArray {
        val list = (0 until n).toMutableList()
        for ((from, to) in moves) list.add(to, list.removeAt(from))
        return list.toIntArray()
    }

    @Test
    fun placesQueuedAfterCurrentInFifoOrder() {
        val order = intArrayOf(4, 0, 2, 5, 1, 3)
        assertArrayEquals(intArrayOf(4, 0, 3, 1, 2, 5), QueueOrder.placeNext(order, 0, listOf(3, 1)))
    }

    @Test
    fun arrangeKeepsAutoplayLastInListOrder() {
        // list 0..7: 5, 6, 7 are autoplay; 3 is queued; current 1
        val order = intArrayOf(6, 2, 1, 7, 0, 4, 5, 3)
        assertArrayEquals(intArrayOf(2, 1, 3, 0, 4, 5, 6, 7), QueueOrder.arrange(order, 1, listOf(3), listOf(7, 5, 6)))
        // idempotent
        val once = QueueOrder.arrange(order, 1, listOf(3), listOf(5, 6, 7))
        assertArrayEquals(once, QueueOrder.arrange(once, 1, listOf(3), listOf(5, 6, 7)))
    }

    @Test
    fun arrangeWhilePlayingAutoplay() {
        // current 5 is autoplay: only autoplay (and the queued 2) is ahead of it
        val order = intArrayOf(6, 0, 5, 1, 7, 2)
        assertArrayEquals(intArrayOf(0, 1, 5, 2, 6, 7), QueueOrder.arrange(order, 5, listOf(2), listOf(5, 6, 7)))
    }

    @Test
    fun linearOrder() {
        val linear = IntArray(6) { it }
        assertArrayEquals(intArrayOf(0, 1, 2, 5, 4, 3), QueueOrder.placeNext(linear, 2, listOf(5, 4)))
        // queued items before the current one move after it
        assertArrayEquals(intArrayOf(1, 2, 3, 0, 4, 5), QueueOrder.placeNext(linear, 3, listOf(0)))
    }

    @Test
    fun ignoresCurrentDuplicatesAndUnknown() {
        val linear = IntArray(4) { it }
        assertArrayEquals(intArrayOf(0, 1, 3, 2), QueueOrder.placeNext(linear, 1, listOf(1, 3, 3, 9)))
        assertArrayEquals(linear, QueueOrder.placeNext(linear, 1, emptyList()))
    }

    @Test
    fun currentUnsetPutsQueuedFirst() {
        assertArrayEquals(intArrayOf(2, 0, 1), QueueOrder.placeNext(intArrayOf(0, 1, 2), -1, listOf(2)))
    }

    @Test
    fun idempotent() {
        val once = QueueOrder.placeNext(intArrayOf(3, 1, 4, 0, 2, 5), 4, listOf(5, 3))
        assertArrayEquals(once, QueueOrder.placeNext(once, 4, listOf(5, 3)))
    }

    @Test
    fun movesReachTarget() {
        val target = QueueOrder.placeNext(IntArray(10) { it }, 2, listOf(7, 5))
        val moves = QueueOrder.moves(target)
        assertEquals(2, moves.size)
        assertArrayEquals(target, apply(10, moves))
        val target2 = intArrayOf(1, 2, 3, 0, 4)
        assertArrayEquals(target2, apply(5, QueueOrder.moves(target2)))
        assertTrue(QueueOrder.moves(IntArray(5) { it }).isEmpty())
        assertTrue(QueueOrder.moves(intArrayOf(0, 0, 1)).isEmpty())
    }
}
