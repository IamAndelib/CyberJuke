package io.github.iamandelib.cyberjuke.bridge

import android.os.Build

/**
 * Who takes Android back: the page (JukePlayerPlugin's back callback is on, and the page closes
 * its top sheet, Now Playing or page, or goes to Home) or Android itself. Following Android's
 * guidance for predictive back, the callback is on only while the page has something to close:
 * at its root, Android 12 and newer take back themselves, move the app to the background (a
 * launcher activity at the root of its task isn't finished) and, from Android 13 on, show the
 * back-to-home animation as the gesture starts. Older Android would finish the activity, and the
 * page would reload next time: there the page keeps back, and moves the app to the background.
 */
internal object BackPolicy {
    fun intercept(sdkInt: Int, canGoBack: Boolean): Boolean = canGoBack || sdkInt < Build.VERSION_CODES.S
}
