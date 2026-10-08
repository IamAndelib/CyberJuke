package io.github.iamandelib.cyberjuke.player

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small encrypted key/value store (e.g. the Cyberspace refresh token). Contract (TS side):
 *
 *   get({ key }): Promise<{ value: string | null }>
 *   set({ key, value }): Promise<void>
 *   remove({ key }): Promise<void>
 *
 * Values are encrypted with AES-256-GCM under an Android Keystore key (alias
 * "cyberjuke_secure", no user authentication); ciphertext and IV are stored as base64 in the
 * private SharedPreferences file "cyberjuke_secure". The entry's key name is bound as GCM
 * associated data. The key is only usable while the device is unlocked (API 28+).
 *
 * A stored value is deleted (and reads as null) only when it can never be decrypted again:
 * tampered or mismatched data (AEADBadTagException), an invalidated or unrecoverable key, a
 * missing key (e.g. after a restore to another phone; the file is also excluded from backups)
 * or bad base64. Any other Keystore error (busy, locked device, transient failure) is retried a
 * few times and then rejects UNAVAILABLE, keeping the value, so a hiccup never signs the user
 * out. `set` behaves the same; it only replaces the key if the key itself is invalid.
 */
@CapacitorPlugin(name = "SecureStore")
class SecureStorePlugin : Plugin() {

    private val executor: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "SecureStore").apply { isDaemon = true }
    }

    @PluginMethod
    fun get(call: PluginCall) {
        val key = keyOf(call) ?: return
        exec(call) {
            val out = JSObject()
            out.put("value", SecureBox.get(context, key) ?: JSONObject.NULL)
            call.resolve(out)
        }
    }

    @PluginMethod
    fun set(call: PluginCall) {
        val key = keyOf(call) ?: return
        val value = call.getString("value")
        if (value == null) {
            call.reject("value is required", "UNAVAILABLE"); return
        }
        exec(call) {
            SecureBox.set(context, key, value)
            call.resolve()
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val key = keyOf(call) ?: return
        exec(call) {
            SecureBox.remove(context, key)
            call.resolve()
        }
    }

    override fun handleOnDestroy() {
        executor.shutdown()
    }

    private fun keyOf(call: PluginCall): String? {
        val key = call.getString("key")?.trim()
        if (key.isNullOrEmpty()) {
            call.reject("key is required", "UNAVAILABLE")
            return null
        }
        return key
    }

    private fun exec(call: PluginCall, work: () -> Unit) {
        try {
            executor.execute {
                try {
                    work()
                } catch (t: Throwable) {
                    Log.w(TAG, "SecureStore failed: ${t.javaClass.simpleName}: ${t.message}")
                    call.reject("secure storage unavailable: ${t.javaClass.simpleName}", "UNAVAILABLE")
                }
            }
        } catch (t: Throwable) { // RejectedExecutionException after destroy
            call.reject("secure storage stopped", "UNAVAILABLE")
        }
    }

    private companion object {
        const val TAG = "CyberJukeSecure"
    }
}

/** The Keystore + SharedPreferences part of [SecureStorePlugin]; synchronized, blocking. */
internal object SecureBox {
    private const val TAG = "CyberJukeSecure"
    private const val ALIAS = "cyberjuke_secure"
    private const val PREFS = "cyberjuke_secure"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val TAG_BITS = 128
    private const val ATTEMPTS = 3
    private const val RETRY_DELAY_MS = 150L

    @Synchronized
    fun get(context: Context, key: String): String? {
        val prefs = prefs(context)
        val ctText = prefs.getString("v_$key", null) ?: return null
        val (iv, ct) = try {
            decode(prefs.getString("iv_$key", null)) to decode(ctText)
        } catch (e: IllegalArgumentException) { // missing IV or bad base64
            drop(prefs, key, "bad data")
            return null
        }
        var last: Exception? = null
        for (attempt in 0 until ATTEMPTS) {
            try {
                val secret = existingKey()
                if (secret == null) {
                    drop(prefs, key, "keystore key missing")
                    return null
                }
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(TAG_BITS, iv))
                cipher.updateAAD(key.toByteArray(StandardCharsets.UTF_8))
                return String(cipher.doFinal(ct), StandardCharsets.UTF_8)
            } catch (e: Exception) {
                if (isKeyInvalid(e)) {
                    drop(prefs, key, e.javaClass.simpleName)
                    deleteKey()
                    return null
                }
                if (e.hasCause<AEADBadTagException>()) {
                    drop(prefs, key, "AEADBadTagException")
                    return null
                }
                last = e
                Log.w(TAG, "keystore error reading '$key' (attempt ${attempt + 1}): ${e.javaClass.simpleName}")
                pause(attempt)
            }
        }
        throw last ?: GeneralSecurityException("keystore unavailable")
    }

    @Synchronized
    fun set(context: Context, key: String, value: String) {
        var last: Exception? = null
        for (attempt in 0 until ATTEMPTS) {
            try {
                val (iv, ct) = encrypt(getOrCreateKey(), key, value)
                prefs(context).edit()
                    .putString("v_$key", Base64.encodeToString(ct, Base64.NO_WRAP))
                    .putString("iv_$key", Base64.encodeToString(iv, Base64.NO_WRAP))
                    .commit()
                return
            } catch (e: Exception) {
                last = e
                if (isKeyInvalid(e)) {
                    // A broken key can never encrypt again: start over with a fresh one.
                    Log.w(TAG, "re-creating keystore key: ${e.javaClass.simpleName}")
                    deleteKey()
                } else {
                    Log.w(TAG, "keystore error writing '$key' (attempt ${attempt + 1}): ${e.javaClass.simpleName}")
                    pause(attempt)
                }
            }
        }
        throw last ?: GeneralSecurityException("keystore unavailable")
    }

    private fun isKeyInvalid(e: Throwable): Boolean =
        e.hasCause<KeyPermanentlyInvalidatedException>() || e.hasCause<UnrecoverableKeyException>()

    private inline fun <reified T : Throwable> Throwable.hasCause(): Boolean {
        var t: Throwable? = this
        var depth = 0
        while (t != null && depth < 8) {
            if (t is T) return true
            t = t.cause
            depth++
        }
        return false
    }

    private fun pause(attempt: Int) {
        if (attempt + 1 >= ATTEMPTS) return
        try {
            Thread.sleep(RETRY_DELAY_MS * (attempt + 1))
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun drop(prefs: SharedPreferences, key: String, why: String) {
        Log.w(TAG, "dropping undecryptable '$key': $why")
        removeEntry(prefs, key)
    }

    @Synchronized
    fun remove(context: Context, key: String) {
        removeEntry(prefs(context), key)
    }

    private fun encrypt(secret: SecretKey, key: String, value: String): Pair<ByteArray, ByteArray> {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secret) // the Keystore picks a random 12-byte IV
        cipher.updateAAD(key.toByteArray(StandardCharsets.UTF_8))
        val ct = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        return cipher.iv to ct
    }

    /** Throws IllegalArgumentException on missing data or bad base64. */
    private fun decode(s: String?): ByteArray {
        if (s.isNullOrEmpty()) throw IllegalArgumentException("missing data")
        return Base64.decode(s, Base64.NO_WRAP)
    }

    private fun removeEntry(prefs: SharedPreferences, key: String) {
        prefs.edit().remove("v_$key").remove("iv_$key").commit()
    }

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? = keyStore().getKey(ALIAS, null) as? SecretKey

    private fun getOrCreateKey(): SecretKey {
        existingKey()?.let { return it }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                return generateKey(unlockedDeviceRequired = true)
            } catch (e: Exception) {
                // Some devices refuse the flag (e.g. no secure lock screen): fall back.
                Log.w(TAG, "unlocked-device key unavailable: ${e.javaClass.simpleName}")
            }
        }
        return generateKey(unlockedDeviceRequired = false)
    }

    private fun generateKey(unlockedDeviceRequired: Boolean): SecretKey {
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(false)
            .setRandomizedEncryptionRequired(true)
        if (unlockedDeviceRequired && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            spec.setUnlockedDeviceRequired(true)
        }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(spec.build())
        return generator.generateKey()
    }

    private fun deleteKey() {
        try {
            keyStore().deleteEntry(ALIAS)
        } catch (e: Exception) {
            Log.w(TAG, "could not delete keystore key: ${e.javaClass.simpleName}")
        }
    }
}
