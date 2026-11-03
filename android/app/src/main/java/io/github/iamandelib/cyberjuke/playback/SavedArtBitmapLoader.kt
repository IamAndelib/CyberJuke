package io.github.iamandelib.cyberjuke.playback

import com.google.common.util.concurrent.Futures
import io.github.iamandelib.cyberjuke.local.LocalLibrary
import android.graphics.Bitmap
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.BitmapLoader
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.ListenableFuture

/**
 * The notification's and lock screen's art: a saved song's cover from the phone ([ArtStore]),
 * else [inner]'s (Media3's, from the network). Media3 sizes and caches whatever this gives
 * (MediaSession.Builder.setBitmapLoader).
 */
@OptIn(UnstableApi::class)
internal class SavedArtBitmapLoader(private val inner: BitmapLoader) : BitmapLoader {
    private fun saved(uri: Uri): Uri? =
        // A local song's cover, kept with the song list; else a saved liked song's.
        JukeUris.localArtIdOf(uri)?.let { id -> LocalLibrary.coverFile(id)?.let { Uri.fromFile(it) } }
            ?: ArtStore.files?.fileFor("GET", uri.toString())?.let { Uri.fromFile(it) }

    override fun supportsMimeType(mimeType: String) = inner.supportsMimeType(mimeType)

    override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> = inner.decodeBitmap(data)

    override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> {
        saved(uri)?.let { return inner.loadBitmap(it) }
        // A local cover that isn't kept (any more): nothing to fetch for our own scheme.
        if (JukeUris.localArtIdOf(uri) != null) return Futures.immediateFailedFuture(java.io.FileNotFoundException("No cover"))
        return inner.loadBitmap(uri)
    }

    // Not left to the interface's default on [inner], which would ask the network, not [loadBitmap].
    override fun loadBitmapFromMetadata(metadata: MediaMetadata): ListenableFuture<Bitmap>? =
        metadata.artworkUri?.let { saved(it) }?.let { inner.loadBitmap(it) } ?: inner.loadBitmapFromMetadata(metadata)
}
