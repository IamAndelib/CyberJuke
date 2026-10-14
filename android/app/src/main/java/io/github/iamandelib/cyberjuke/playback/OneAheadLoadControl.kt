package io.github.iamandelib.cyberjuke.playback

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.LoadControl
import androidx.media3.exoplayer.analytics.PlayerId
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.TrackGroupArray
import androidx.media3.exoplayer.trackselection.ExoTrackSelection
import androidx.media3.exoplayer.upstream.Allocator

/**
 * [inner] (BufferPolicy's deep buffer), but loading only the playing item and the next one in
 * play order ([LoadAhead]). PlaybackService sets [currentIndex] and [nextIndex] on the main
 * thread; the player reads them on its playback thread. Everything else is [inner]'s.
 */
@OptIn(UnstableApi::class)
internal class OneAheadLoadControl(private val inner: LoadControl) : LoadControl {
    @Volatile
    var currentIndex: Int = C.INDEX_UNSET

    @Volatile
    var nextIndex: Int = C.INDEX_UNSET

    /** Playback thread only. */
    private val period = Timeline.Period()

    override fun shouldContinueLoading(parameters: LoadControl.Parameters): Boolean {
        // Asked first, so its own loading state stays up to date.
        val wanted = inner.shouldContinueLoading(parameters)
        return wanted && LoadAhead.mayLoad(windowOf(parameters), currentIndex, nextIndex)
    }

    private fun windowOf(parameters: LoadControl.Parameters): Int {
        val timeline = parameters.timeline
        if (timeline.isEmpty) return C.INDEX_UNSET
        val index = timeline.getIndexOfPeriod(parameters.mediaPeriodId.periodUid)
        if (index == C.INDEX_UNSET) return C.INDEX_UNSET
        return timeline.getPeriod(index, period).windowIndex
    }

    override fun onPrepared(playerId: PlayerId) = inner.onPrepared(playerId)

    override fun onTracksSelected(
        parameters: LoadControl.Parameters,
        trackGroups: TrackGroupArray,
        trackSelections: Array<ExoTrackSelection?>,
    ) = inner.onTracksSelected(parameters, trackGroups, trackSelections)

    override fun onStopped(playerId: PlayerId) = inner.onStopped(playerId)

    override fun onReleased(playerId: PlayerId) = inner.onReleased(playerId)

    override fun getAllocator(playerId: PlayerId): Allocator = inner.getAllocator(playerId)

    override fun getBackBufferDurationUs(playerId: PlayerId): Long = inner.getBackBufferDurationUs(playerId)

    override fun retainBackBufferFromKeyframe(playerId: PlayerId): Boolean = inner.retainBackBufferFromKeyframe(playerId)

    override fun shouldStartPlayback(parameters: LoadControl.Parameters): Boolean = inner.shouldStartPlayback(parameters)

    override fun shouldContinuePreloading(
        playerId: PlayerId,
        timeline: Timeline,
        mediaPeriodId: MediaSource.MediaPeriodId,
        bufferedDurationUs: Long,
    ): Boolean = inner.shouldContinuePreloading(playerId, timeline, mediaPeriodId, bufferedDurationUs)
}
