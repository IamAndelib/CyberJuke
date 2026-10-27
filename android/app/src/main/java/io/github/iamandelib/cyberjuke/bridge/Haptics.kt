package io.github.iamandelib.cyberjuke.bridge

import androidx.core.view.HapticFeedbackConstantsCompat

/**
 * The page's haptic kinds (`haptic({ kind })`) as Android feedback constants. They go through
 * ViewCompat.performHapticFeedback, which falls back on older Android: CONFIRM is VIRTUAL_KEY
 * before Android 11, GESTURE_THRESHOLD_ACTIVATE is CONTEXT_CLICK before Android 14.
 */
internal object Haptics {
    /** null for an unknown kind. */
    fun constantFor(kind: String?): Int? = when (kind) {
        // Holding a track row opens its menu.
        "longPress" -> HapticFeedbackConstantsCompat.LONG_PRESS
        // ♥ and ★: a like or a favourite was given or taken back.
        "confirm" -> HapticFeedbackConstantsCompat.CONFIRM
        // A swipe down on Now Playing has gone far enough to close it on release.
        "threshold" -> HapticFeedbackConstantsCompat.GESTURE_THRESHOLD_ACTIVATE
        else -> null
    }
}
