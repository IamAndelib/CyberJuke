package io.github.iamandelib.cyberjuke.player

import kotlin.math.abs

/**
 * Pure lyrics helpers: LRC parsing and LRCLIB result choice. No Android types (org.json is
 * only stubbed in JVM unit tests), unit-tested in LrcTest.
 */
internal object Lrc {

    /** One timed line; [t] in milliseconds from the start of the track. */
    data class Line(val t: Long, val text: String)

    private val TAG_RE = Regex("""^\[([^\]]*)]""")
    private val TIME_RE = Regex("""^\s*(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\s*$""")
    private val OFFSET_RE = Regex("""^\s*offset\s*:\s*([+-]?\d+)\s*$""", RegexOption.IGNORE_CASE)
    private val WORD_TIME_RE = Regex("""<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>""")

    /**
     * Parses LRC text into lines sorted by time.
     *
     * - `[mm:ss.xx]`, `[mm:ss.xxx]`, `[mm:ss:xx]` and `[mm:ss]`; a fraction of 1, 2 or 3
     *   digits means tenths, hundredths or milliseconds.
     * - Several timestamps on one line (`[00:10.00][01:20.00]Chorus`) give one entry each.
     * - `[offset:+500]` (ms, anywhere in the file) applies to every line: positive shows the
     *   lyrics earlier (t - offset), as in the LRC spec. Times are clamped at 0.
     * - Metadata lines (`[ar:…]`, `[ti:…]`, `[length:…]`) and lines without a timestamp are
     *   skipped. A non-time tag after the timestamps is kept as text (`[00:05.00][Chorus]`).
     * - Enhanced-LRC word times (`<00:12.34>`) are removed from the text.
     * - Timed blank lines are kept with empty text (they mark pauses between verses).
     * - Lines with the same time keep their file order (stable sort).
     */
    fun parse(lrc: String?): List<Line> {
        if (lrc.isNullOrBlank()) return emptyList()
        var offset = 0L
        val out = ArrayList<Line>()
        for (raw in lrc.lineSequence()) {
            var rest = raw.trimStart('﻿').trim()
            val times = ArrayList<Long>()
            while (true) {
                val m = TAG_RE.find(rest) ?: break
                val tag = m.groupValues[1]
                val time = timeOf(tag)
                if (time != null) {
                    times.add(time)
                    rest = rest.substring(m.value.length)
                } else {
                    if (times.isEmpty()) {
                        OFFSET_RE.find(tag)?.let { o -> o.groupValues[1].toLongOrNull()?.let { offset = it } }
                    }
                    break
                }
            }
            if (times.isEmpty()) continue
            val text = rest.replace(WORD_TIME_RE, "").replace(Regex("""\s+"""), " ").trim()
            for (t in times) out.add(Line(t, text))
        }
        return out
            .map { it.copy(t = (it.t - offset).coerceAtLeast(0L)) }
            .sortedBy { it.t }
    }

    private fun timeOf(tag: String): Long? {
        val m = TIME_RE.find(tag) ?: return null
        val min = m.groupValues[1].toLong()
        val sec = m.groupValues[2].toLong()
        if (sec >= 60) return null
        val frac = m.groupValues[3]
        val ms = when (frac.length) {
            0 -> 0L
            1 -> frac.toLong() * 100
            2 -> frac.toLong() * 10
            else -> frac.toLong()
        }
        return min * 60_000 + sec * 1000 + ms
    }

    /** The fields of an LRCLIB record that matter here (`/api/get`, `/api/search`). */
    data class LrclibEntry(
        val trackName: String,
        val artistName: String,
        val durationSec: Double?,
        val instrumental: Boolean,
        val plain: String?,
        val synced: String?,
    ) {
        val hasLyrics: Boolean get() = !synced.isNullOrBlank() || !plain.isNullOrBlank()
        val usable: Boolean get() = hasLyrics || instrumental
    }

    /**
     * Best LRCLIB search result for a track, or null.
     *
     * - Only usable entries (lyrics or instrumental).
     * - The artist must match exactly by credit name ([MusicText.creditsOverlap]), so
     *   "Ivy Queen" never stands in for "Queen". A blank [artist] skips this check.
     * - With [durationSec], the entry's duration must be known and within ±[tolerance] s.
     * - Then: entries with synced lyrics first, then lyrics over instrumental, then the
     *   closest duration; ties keep LRCLIB's order.
     */
    fun pickBest(
        entries: List<LrclibEntry>,
        artist: String,
        durationSec: Double?,
        tolerance: Double = 3.0,
    ): LrclibEntry? {
        return entries
            .asSequence()
            .filter { it.usable }
            .filter { artist.isBlank() || MusicText.creditsOverlap(artist, it.artistName) }
            .filter { e ->
                durationSec == null || (e.durationSec != null && abs(e.durationSec - durationSec) <= tolerance)
            }
            .sortedWith(
                compareBy<LrclibEntry>(
                    { if (!it.synced.isNullOrBlank()) 0 else 1 },
                    { if (it.hasLyrics) 0 else 1 },
                    { if (durationSec != null && it.durationSec != null) abs(it.durationSec - durationSec) else 0.0 },
                ),
            )
            .firstOrNull()
    }
}
