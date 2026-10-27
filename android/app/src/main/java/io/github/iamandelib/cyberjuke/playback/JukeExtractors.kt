package io.github.iamandelib.cyberjuke.playback

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.mp3.Mp3Extractor
import androidx.media3.extractor.text.SubtitleParser

/**
 * The extractors for a load. A Jukebox MP3 is read as an MP3 and nothing else: Media3 passes
 * the item's own URI here (ProgressiveMediaSource: its `cyberjuke://mp3/<file>`), and such an
 * item gets [Mp3Extractor] alone, with [mp3Flags]. Its metadata stays what the post says, as
 * a file that is really another container isn't sniffed and read. Every other load gets
 * [defaults], which also take the settings Media3's media source factory makes.
 */
@OptIn(UnstableApi::class)
internal class JukeExtractors(
    private val defaults: ExtractorsFactory,
    private val mp3Flags: Int,
) : ExtractorsFactory {
    override fun createExtractors(): Array<Extractor> = defaults.createExtractors()

    override fun createExtractors(uri: Uri, responseHeaders: Map<String, List<String>>): Array<Extractor> =
        if (JukeUris.mp3UrlOf(uri) != null) arrayOf(Mp3Extractor(mp3Flags)) else defaults.createExtractors(uri, responseHeaders)

    override fun setSubtitleParserFactory(subtitleParserFactory: SubtitleParser.Factory): ExtractorsFactory {
        defaults.setSubtitleParserFactory(subtitleParserFactory)
        return this
    }

    @Deprecated("Media3's legacy subtitle path; passed on to the defaults")
    override fun experimentalSetTextTrackTranscodingEnabled(textTrackTranscodingEnabled: Boolean): ExtractorsFactory {
        @Suppress("DEPRECATION")
        defaults.experimentalSetTextTrackTranscodingEnabled(textTrackTranscodingEnabled)
        return this
    }

    override fun experimentalSetCodecsToParseWithinGopSampleDependencies(codecsToParseWithinGopSampleDependencies: Int): ExtractorsFactory {
        defaults.experimentalSetCodecsToParseWithinGopSampleDependencies(codecsToParseWithinGopSampleDependencies)
        return this
    }

    override fun setParseHagcMetadata(parseHagcMetadata: Boolean): ExtractorsFactory {
        defaults.setParseHagcMetadata(parseHagcMetadata)
        return this
    }
}
