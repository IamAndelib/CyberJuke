package io.github.iamandelib.cyberjuke.playback

import android.os.Bundle
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ShuffleOrder.DefaultShuffleOrder
import java.util.Random

/** [QueueHost] over the service's ExoPlayer: the queue rules ([NativeQueue]) act through it. */
@OptIn(UnstableApi::class)
internal class ExoQueueHost(private val p: ExoPlayer) : QueueHost<MediaItem> {
    private val shuffleSeeds = Random()

    override val count: Int get() = p.mediaItemCount
    override val currentIndex: Int get() = if (p.mediaItemCount == 0) -1 else p.currentMediaItemIndex
    override val shuffleEnabled: Boolean get() = p.shuffleModeEnabled

    override fun serialAt(index: Int): Long =
        p.getMediaItemAt(index).mediaMetadata.extras?.getLong(JukeCommands.EXTRA_QUEUE_SERIAL, 0L) ?: 0L

    override fun shuffleOrder(): IntArray? {
        val n = p.mediaItemCount
        val shuffle = p.shuffleOrder
        if (n == 0 || shuffle.length != n) return null
        val order = IntArray(n)
        var i = shuffle.firstIndex
        var k = 0
        while (i != C.INDEX_UNSET && k < n) {
            order[k++] = i
            i = shuffle.getNextIndex(i)
        }
        return if (k == n) order else null
    }

    override fun setShuffleOrder(order: IntArray) {
        p.setShuffleOrder(DefaultShuffleOrder(order, shuffleSeeds.nextLong()))
    }

    override fun moveItem(from: Int, to: Int) = p.moveMediaItem(from, to)

    override fun insertTagged(at: Int?, items: List<MediaItem>, serials: List<Long>) {
        val tagged = items.mapIndexed { k, item -> tag(item) { putLong(JukeCommands.EXTRA_QUEUE_SERIAL, serials[k]) } }
        if (at == null) p.addMediaItems(tagged) else p.addMediaItems(at, tagged)
    }

    override fun itemAt(index: Int): MediaItem = p.getMediaItemAt(index)

    override fun idAt(index: Int): String = p.getMediaItemAt(index).mediaId

    override fun isAutoAt(index: Int): Boolean =
        p.getMediaItemAt(index).mediaMetadata.extras?.getBoolean(QueueCommands.EXTRA_AUTOPLAY, false) == true

    override fun setItems(items: List<MediaItem>, serials: List<Long>, start: Int, positionMs: Long) {
        if (items.isEmpty()) {
            p.clearMediaItems()
            return
        }
        val tagged = items.mapIndexed { k, item ->
            if (serials[k] == 0L) item else tag(item) { putLong(JukeCommands.EXTRA_QUEUE_SERIAL, serials[k]) }
        }
        p.setMediaItems(tagged, start, positionMs.coerceAtLeast(0L))
    }

    override fun insertAuto(at: Int?, items: List<MediaItem>) {
        val tagged = items.map { tag(it) { putBoolean(QueueCommands.EXTRA_AUTOPLAY, true) } }
        if (at == null) p.addMediaItems(tagged) else p.addMediaItems(at, tagged)
    }

    override fun removeAt(index: Int) = p.removeMediaItem(index)

    override fun seekTo(index: Int) = p.seekTo(index, 0L)

    private inline fun tag(item: MediaItem, edit: Bundle.() -> Unit): MediaItem {
        val extras = Bundle(item.mediaMetadata.extras ?: Bundle.EMPTY).apply(edit)
        return item.buildUpon()
            .setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(extras).build())
            .build()
    }
}
