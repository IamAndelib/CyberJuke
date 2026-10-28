package io.github.iamandelib.cyberjuke.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackPolicyTest {
    @Test
    fun thePageTakesBackWhileItHasSomethingToClose() {
        for (sdk in listOf(24, 28, 30, 31, 33, 34, 36)) {
            assertTrue("API $sdk", BackPolicy.intercept(sdk, canGoBack = true))
        }
    }

    @Test
    fun atTheRootAndroid12AndNewerTakeBackThemselves() {
        for (sdk in listOf(31, 32, 33, 34, 35, 36)) {
            assertFalse("API $sdk", BackPolicy.intercept(sdk, canGoBack = false))
        }
    }

    @Test
    fun atTheRootOlderAndroidLeavesItToThePageWhichBackgroundsTheApp() {
        for (sdk in listOf(24, 25, 26, 28, 29, 30)) {
            assertTrue("API $sdk", BackPolicy.intercept(sdk, canGoBack = false))
        }
    }
}
