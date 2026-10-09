package io.github.iamandelib.cyberjuke.yt

import io.github.iamandelib.cyberjuke.net.BlockReason
import io.github.iamandelib.cyberjuke.net.BlockedException
import org.junit.Assert.assertEquals
import org.junit.Test
import org.schabi.newpipe.extractor.exceptions.ExtractionException
import java.io.IOException

class YtMusicErrorTest {
    @Test
    fun aRefusalDuringABackOffRejectsBotCheck() {
        // L10: a search, playlist, artist or lyrics call refused by the back-off is BOT_CHECK,
        // also when NewPipe wraps it (not NETWORK, which would read as "offline").
        val blocked = BlockedException(1L, BlockReason.BOT_CHECK)
        assertEquals("BOT_CHECK", YtMusic.errorCode(blocked))
        assertEquals("BOT_CHECK", YtMusic.errorCode(ExtractionException("Could not fetch", blocked)))
        assertEquals("NETWORK", YtMusic.errorCode(IOException("timeout")))
    }
}
