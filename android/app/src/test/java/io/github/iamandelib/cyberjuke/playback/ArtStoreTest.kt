package io.github.iamandelib.cyberjuke.playback

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class ArtStoreTest {
    private val id = "dQw4w9WgXcQ"
    private val hq = "https://i.ytimg.com/vi/$id/hqdefault.jpg"
    private val mq = "https://i.ytimg.com/vi/$id/mqdefault.jpg"

    @Test
    fun aSavedVideoKeepsTheFramesTheAppShows() {
        // Rows show the small frame, Now Playing and the lock screen the big one.
        assertEquals(listOf(hq, mq), ArtStore.coversOf(id))
        // A Jukebox MP3's cover comes with it (setLikedIds), not from its id.
        assertTrue(ArtStore.coversOf("mp3:IZq8cMcx.mp3").isEmpty())
    }

    @Test
    fun namesComeFromTheVideoAndTheFrame() {
        assertEquals("$id-hq.jpg", ArtStore.nameFor(hq))
        assertEquals("$id-mq.jpg", ArtStore.nameFor(mq))
    }

    @Test
    fun rejectsForeignHosts() {
        for (url in listOf(
            "https://evil.example/vi/$id/hqdefault.jpg",
            "http://i.ytimg.com/vi/$id/hqdefault.jpg",
            "https://i.ytimg.com/vi/$id/maxresdefault.jpg",
            "https://i.ytimg.com/vi/../$id/hqdefault.jpg",
            "https://i.ytimg.com/vi/$id/hqdefault.jpg?x=1",
            "https://user@i.ytimg.com/vi/$id/hqdefault.jpg",
            "",
        )) {
            assertNull(url, ArtStore.nameFor(url))
        }
    }

    @Test
    fun onlyACoverOnThePhoneIsServedAndOnlyForAGet() {
        val dir = Files.createTempDirectory("art").toFile()
        val store = ArtStore.Files(dir)
        assertNull(store.fileFor("GET", hq))
        dir.resolve("$id-hq.jpg").writeBytes(byteArrayOf(1, 2, 3))
        assertEquals(dir.resolve("$id-hq.jpg"), store.fileFor("GET", hq))
        assertNull(store.fileFor("POST", hq))
        assertNull(store.fileFor("GET", mq))
        // Not saved yet: its covers are missing.
        assertEquals(listOf(mq), store.missing(id))
        dir.deleteRecursively()
    }

    /** A client that answers every request with [code] and [body], without the network. */
    private fun answering(code: Int, body: ByteArray) = OkHttpClient.Builder().addInterceptor { chain ->
        Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(code).message("x")
            .body(body.toResponseBody("image/jpeg".toMediaType())).build()
    }.build()

    @Test
    fun aFetchedCoverIsPutInPlaceWholeAndOnlyASmallOneIsKept() {
        val dir = Files.createTempDirectory("art").toFile()
        val store = ArtStore.Files(dir)
        assertTrue(store.fetch(hq, answering(200, byteArrayOf(7, 8))))
        assertEquals(listOf<Byte>(7, 8), store.fileFor("GET", hq)!!.readBytes().toList())
        assertFalse(store.fetch(mq, answering(404, byteArrayOf())))
        assertFalse(store.fetch(mq, answering(200, ByteArray(ArtStore.MAX_BYTES.toInt() + 1))))
        assertNull(store.fileFor("GET", mq))
        assertFalse(store.fetch("https://evil.example/x.jpg", answering(200, byteArrayOf(1))))
        assertEquals(setOf("$id-hq.jpg"), dir.list()!!.filterNot { it.endsWith(".part") }.toSet())
        dir.deleteRecursively()
    }

    @Test
    fun aJukeboxMp3KeepsTheCoverThePageSent() {
        val mp3 = "mp3:IZq8cMcx.mp3"
        val cover = "https://bunker.cyberspace.online/uploads/jukebox/c1.jpg"
        ArtStore.setMp3Covers(mapOf(mp3 to cover, "mp3:FEHdI7AK.mp3" to "https://evil.example/c.jpg", id to cover))
        // Only an MP3's, and only the site's covers.
        assertEquals(listOf(cover), ArtStore.coversOf(mp3))
        assertTrue(ArtStore.coversOf("mp3:FEHdI7AK.mp3").isEmpty())
        assertEquals(listOf(hq, mq), ArtStore.coversOf(id))
        // Kept under a name of its own, never the URL's.
        val name = ArtStore.nameFor(cover)!!
        assertTrue(name, Regex("^c-[0-9a-f]{32}$").matches(name))
        assertNull(ArtStore.nameFor("https://evil.example/c.jpg"))
        ArtStore.setMp3Covers(emptyMap())
    }

    @Test
    fun mp3CoversStayUntilThePageHasSaidWhichAreLiked() {
        val dir = Files.createTempDirectory("art").toFile()
        val store = ArtStore.Files(dir)
        val cover = "https://bunker.cyberspace.online/uploads/jukebox/c1.jpg"
        ArtStore.forgetMp3Covers()
        val name = ArtStore.nameFor(cover)!!
        dir.resolve(name).writeText("x")
        // A fresh start: not known yet, so not taken.
        store.keepOnly(setOf(id))
        assertTrue(dir.resolve(name).exists())
        // Known: kept while liked, gone after.
        ArtStore.setMp3Covers(mapOf("mp3:IZq8cMcx.mp3" to cover))
        store.keepOnly(setOf("mp3:IZq8cMcx.mp3"))
        assertTrue(dir.resolve(name).exists())
        store.keepOnly(setOf(id))
        assertFalse(dir.resolve(name).exists())
        ArtStore.forgetMp3Covers()
        dir.deleteRecursively()
    }

    @Test
    fun coversOfSongsNoLongerLikedGo() {
        val dir = Files.createTempDirectory("art").toFile()
        val store = ArtStore.Files(dir)
        val other = "aaaaaaaaaaa"
        for (name in listOf("$id-hq.jpg", "$id-mq.jpg", "$other-hq.jpg", "$other-hq.jpg.part")) dir.resolve(name).writeText("x")
        store.keepOnly(setOf(id))
        assertEquals(setOf("$id-hq.jpg", "$id-mq.jpg"), dir.list()!!.toSet())
        store.remove(id)
        assertFalse(dir.resolve("$id-hq.jpg").exists())
        dir.deleteRecursively()
    }
}
