package io.github.iamandelib.cyberjuke

import android.content.Context

/**
 * The window before the page has drawn. The theme's background is kept here (SharedPreferences
 * [PREFS]; the page sends it whenever the theme changes, JukePlayer.setThemeBackground), so the
 * window and the WebView open in it, not in black on a light theme. And the launch splash stays
 * until the page's first screen, for at most [SPLASH_MAX_MS].
 */
object ThemeWindow {
    private const val PREFS = "cyberjuke_ui"
    private const val KEY_BACKGROUND = "background"

    /** Black: the default theme's background, and the splash's. */
    const val DEFAULT_BACKGROUND: Int = 0xFF000000.toInt()

    /** The longest the launch splash waits for the page's first screen. */
    const val SPLASH_MAX_MS = 1_500L

    /** An opaque colour from CSS `#rgb` or `#rrggbb` (a theme's `--color-bg`), else null. */
    @JvmStatic
    fun parse(css: String?): Int? {
        if (css == null || !css.startsWith('#')) return null
        val hex = css.substring(1)
        if (!hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
        val rgb = when (hex.length) {
            3 -> hex.map { "$it$it" }.joinToString("")
            6 -> hex
            else -> return null
        }
        return (0xFF000000L or rgb.toLong(16)).toInt()
    }

    /**
     * Whether the window paints the navigation bar in the theme's background itself: on Android
     * 8 and 9 (API 26 to 28) edge to edge leaves it a light scrim (androidx EdgeToEdge: no system
     * dark mode to say otherwise), under the light buttons a dark theme asks for. Before 26 that
     * scrim is dark, and dark buttons can't be had; from 29 the bar is transparent over the page.
     */
    @JvmStatic
    fun paintsNavigationBar(sdk: Int): Boolean = sdk in 26..28

    /** Keep the splash up: the page hasn't shown its first screen, and it hasn't waited too long. */
    @JvmStatic
    fun keepSplash(waitedMs: Long, firstScreenShown: Boolean): Boolean = !firstScreenShown && waitedMs < SPLASH_MAX_MS

    /** The theme's background as the page last sent it; black before it ever has. */
    @JvmStatic
    fun saved(context: Context): Int = prefs(context).getInt(KEY_BACKGROUND, DEFAULT_BACKGROUND)

    fun save(context: Context, color: Int) {
        prefs(context).edit().putInt(KEY_BACKGROUND, color).apply()
    }

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
