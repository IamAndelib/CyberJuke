package io.github.iamandelib.cyberjuke.player

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
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
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
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
 * associated data. A value that can no longer be decrypted (key invalidated or missing, e.g.
 * after a backup restore to another phone) is deleted and reads as null. `set` rejects
 * UNAVAILABLE if the Keystore cannot encrypt.
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

    @Synchronized
    fun get(context: Context, key: String): String? {
        val prefs = prefs(context)
        val ct = prefs.getString("v_$key", null) ?: return null
        val iv = prefs.getString("iv_$key", null)
        return try {
            val secret = existingKey() ?: throw GeneralSecurityException("keystore key missing")
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(TAG_BITS, decode(iv)))
            cipher.updateAAD(key.toByteArray(StandardCharsets.UTF_8))
            String(cipher.doFinal(decode(ct)), StandardCharsets.UTF_8)
        } catch (e: java.security.KeyStoreException) {
            Log.w(TAG, "keystore unavailable reading '$key': ${e.message}")
            null // transient: keep the value
        } catch (e: Exception) {
            // Invalidated / missing key, tampered or truncated data: the value is unrecoverable.
            Log.w(TAG, "dropping undecryptable '$key': ${e.javaClass.simpleName}")
            removeEntry(prefs, key)
            if (e is java.security.UnrecoverableKeyException ||
                e is android.security.keystore.KeyPermanentlyInvalidatedException
            ) {
                deleteKey()
            }
            null
        }
    }

    @Synchronized
    fun set(context: Context, key: String, value: String) {
        val (iv, ct) = try {
            encrypt(getOrCreateKey(), key, value)
        } catch (e: GeneralSecurityException) {
            // A broken key (e.g. invalidated): start over with a fresh one, once.
            Log.w(TAG, "re-creating keystore key: ${e.javaClass.simpleName}")
            deleteKey()
            encrypt(getOrCreateKey(), key, value)
        }
        prefs(context).edit()
            .putString("v_$key", Base64.encodeToString(ct, Base64.NO_WRAP))
            .putString("iv_$key", Base64.encodeToString(iv, Base64.NO_WRAP))
            .commit()
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
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
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
