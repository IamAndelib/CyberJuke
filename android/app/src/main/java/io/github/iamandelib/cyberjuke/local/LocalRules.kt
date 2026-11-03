package io.github.iamandelib.cyberjuke.local

import java.security.MessageDigest

/**
 * The pure rules of local music (docs/superpowers/specs/2026-11-03-local-music-design.md): which
 * files are songs, which folders overlap, what a song is called, its id, and which cover goes
 * with it. Nothing here touches Android (LocalRulesTest).
 */
internal object LocalRules {
    /** How a newly chosen folder stands to one already chosen. */
    enum class Relation { NONE, INSIDE, CONTAINS }

    /** A chosen folder: its document provider and the document id of its root ("primary:Music"). */
    data class TreeRef(val authority: String, val docId: String)

    /**
     * [new] against [existing]: INSIDE when it is the same folder or one inside it, CONTAINS when
     * [existing] is inside [new]. A document id is "<volume>:<path>" for the phone's own storage
     * provider; any other provider's ids are compared whole, so only the same folder counts.
     */
    fun relation(new: TreeRef, existing: TreeRef): Relation = when {
        new.authority != existing.authority -> Relation.NONE
        within(new.docId, existing.docId) -> Relation.INSIDE
        within(existing.docId, new.docId) -> Relation.CONTAINS
        else -> Relation.NONE
    }

    private fun within(child: String, parent: String): Boolean {
        if (child == parent) return true
        val c = child.indexOf(':')
        val p = parent.indexOf(':')
        if (c < 0 || p < 0 || child.substring(0, c) != parent.substring(0, p)) return false
        val cPath = child.substring(c + 1).trim('/')
        val pPath = parent.substring(p + 1).trim('/')
        return pPath.isEmpty() || cPath.startsWith("$pPath/")
    }

    /** The extensions played: what Media3's own extractors read. */
    val AUDIO_EXTENSIONS = setOf("mp3", "flac", "ogg", "oga", "opus", "m4a", "aac", "wav")

    private val AUDIO_MIMES = setOf(
        "audio/mpeg", "audio/mp3", "audio/flac", "audio/x-flac", "audio/ogg", "audio/opus",
        "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/x-wav", "audio/vnd.wave",
    )

    /** Hidden names (a leading dot) are skipped, files and folders alike. */
    fun isHidden(name: String): Boolean = name.startsWith(".")

    /** A song: not hidden, and a known audio type by its MIME type or, when a provider gives none, its extension. */
    fun isAudio(mime: String?, name: String): Boolean =
        !isHidden(name) && (mime?.lowercase() in AUDIO_MIMES || extensionOf(name) in AUDIO_EXTENSIONS)

    private fun extensionOf(name: String): String = name.substringAfterLast('.', "").lowercase()

    /** Which tags a song is read for: 2 added album artist, track, disc and year; 3 the file name's guess. */
    const val TAGS = 3

    /** Whether a file seen before has to be read again: new, a different size or date, or read for fewer tags. */
    fun needsRead(old: LocalIndex.Entry?, size: Long, modified: Long): Boolean =
        old == null || old.size != size || old.modified != modified || old.tags < TAGS

    /** A track or disc number tag ("4", "4/12", " 04 "): its number, 0 when there is none. */
    fun number(tag: String?): Int = tag?.trim()?.substringBefore('/')?.trim()?.toIntOrNull()?.takeIf { it in 1..9999 } ?: 0

    /** A year or date tag ("1990", "1990-05-01", "19900501T000000.000Z"): its year, 0 when there is none. */
    fun year(tag: String?): Int = tag?.trim()?.take(4)?.toIntOrNull()?.takeIf { it in 1000..9999 } ?: 0

    /**
     * A song's id: `loc:` and the first 16 hex of SHA-256 of its provider and document id. It
     * stays the same while the file isn't moved or renamed, whichever chosen folder reaches it.
     */
    fun idOf(authority: String, docId: String): String = "loc:" + sha256("$authority\n$docId").take(16)

    /** Whether [id] has the shape [idOf] gives. */
    fun isId(id: String): Boolean = ID.matches(id)

    private val ID = Regex("^loc:[0-9a-f]{16}$")

    /** The title shown: the tag, else the file name without its extension. */
    fun shownTitle(tag: String?, fileName: String): String =
        tag?.trim()?.takeIf { it.isNotEmpty() } ?: fileName.substringBeforeLast('.').ifEmpty { fileName }

    const val UNKNOWN_ARTIST = "Unknown artist"

    private val NAME_SPLIT = Regex(" [-–—] ")

    /**
     * A file named "Artist - Title.mp3" (a downloaded song's usual name), for a song with
     * neither an artist nor a title tag: its artist and title. Null unless the name is exactly two
     * parts around " - " (or an en or em dash), and the first isn't a track number ("01 - Title").
     */
    fun guessFromName(fileName: String): Pair<String, String>? {
        val parts = fileName.substringBeforeLast('.').split(NAME_SPLIT).map { it.trim() }
        if (parts.size != 2 || parts.any { it.isEmpty() } || parts[0].all { it.isDigit() }) return null
        return parts[0] to parts[1]
    }

    /** The artist shown: the tag, else the album artist's, else "Unknown artist". */
    fun shownArtist(artist: String?, albumArtist: String?): String =
        listOf(artist, albumArtist).firstNotNullOfOrNull { it?.trim()?.takeIf { s -> s.isNotEmpty() } } ?: UNKNOWN_ARTIST

    /** A folder's cover picture, by name, in this order: the first of them among [names]. */
    private val COVER_NAMES = listOf("cover.jpg", "cover.jpeg", "cover.png", "folder.jpg", "folder.jpeg", "folder.png", "front.jpg", "front.png")

    fun coverName(names: Collection<String>): String? {
        val byLower = names.associateBy { it.lowercase() }
        return COVER_NAMES.firstNotNullOfOrNull { byLower[it] }
    }

    private fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}
