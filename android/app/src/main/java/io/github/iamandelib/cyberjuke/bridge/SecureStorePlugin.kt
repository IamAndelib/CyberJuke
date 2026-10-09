package io.github.iamandelib.cyberjuke.bridge

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.security.GeneralSecurityException
import java.security.KeyStore
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
 * A stored value is deleted (and reads as null) only when it can never be decrypted again
 * ([KeyErrors]): tampered or mismatched data (AEADBadTagException), a permanently invalidated
 * key, a Keystore error Android 13+ reports as permanent (a corrupt or missing key blob after an
 * update or a restore), a missing key (e.g. after a restore to another phone; the file is also
 * excluded from backups) or bad base64. Any other Keystore error (busy, locked device, a
 * transient failure, or an UnrecoverableKeyException Android does not classify) is retried a
 * few times and then rejects UNAVAILABLE, keeping the value, so a hiccup never signs the user
 * out.
 *
 * `set` replaces the value anyway, so it never stays stuck: when the key keeps failing (other
 * than on a locked device) it deletes the key and tries once more with a fresh one. A key from
 * before the unlocked-device rule is replaced, its values re-encrypted, on the next `set`. A
 * failed disk write (commit() false) rejects.
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

    /** How the current key was made ("unlocked" / "plain"); absent for keys from before S4. */
    private const val PREF_KEY_FLAGS = "key_flags"

    /** SharedPreferences.commit() returned false (disk full?): nothing was stored. */
    class DiskWriteException : IOException("could not write secure storage")

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
                return decrypt(secret, key, iv, ct)
            } catch (e: Exception) {
                when (classify(e)) {
                    KeyErrors.Kind.PERMANENT -> {
                        drop(prefs, key, e.javaClass.simpleName)
                        deleteKey()
                        return null
                    }
                    KeyErrors.Kind.BAD_DATA -> {
                        drop(prefs, key, "AEADBadTagException")
                        return null
                    }
                    else -> Unit
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
        val prefs = prefs(context)
        migrateKey(prefs)
        var last: Exception? = null
        for (attempt in 0 until ATTEMPTS) {
            try {
                write(prefs, key, value)
                return
            } catch (e: DiskWriteException) {
                throw e
            } catch (e: Exception) {
                last = e
                if (classify(e) == KeyErrors.Kind.PERMANENT) {
                    // A broken key can never encrypt again: start over with a fresh one.
                    Log.w(TAG, "re-creating keystore key: ${e.javaClass.simpleName}")
                    deleteKey()
                } else {
                    Log.w(TAG, "keystore error writing '$key' (attempt ${attempt + 1}): ${e.javaClass.simpleName}")
                    pause(attempt)
                }
            }
        }
        val failure = last ?: GeneralSecurityException("keystore unavailable")
        if (classify(failure) == KeyErrors.Kind.LOCKED) throw failure
        // Still failing, and not because the device is locked: the key is likely broken in a way
        // Android does not report (M4). `set` replaces the value anyway, so one more try with a
        // fresh key costs nothing and the user can always sign in again.
        Log.w(TAG, "re-creating keystore key after $ATTEMPTS failures: ${failure.javaClass.simpleName}")
        deleteKey()
        write(prefs, key, value)
    }

    @Synchronized
    fun remove(context: Context, key: String) {
        if (!prefs(context).edit().remove("v_$key").remove("iv_$key").commit()) throw DiskWriteException()
    }

    /** Encrypts under the current (or a new) key and commits; [DiskWriteException] if not written. */
    private fun write(prefs: SharedPreferences, key: String, value: String) {
        val (iv, ct) = encrypt(getOrCreateKey(prefs), key, value)
        val ok = prefs.edit()
            .putString("v_$key", Base64.encodeToString(ct, Base64.NO_WRAP))
            .putString("iv_$key", Base64.encodeToString(iv, Base64.NO_WRAP))
            .commit()
        if (!ok) throw DiskWriteException()
    }

    /**
     * L11: a key made before the unlocked-device rule (no [PREF_KEY_FLAGS] marker) is replaced
     * by one that has it, and what it protected is re-encrypted. Postponed (tried again on the
     * next `set`) while a value cannot be read; a value that can never be read again is dropped.
     */
    private fun migrateKey(prefs: SharedPreferences) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P || prefs.contains(PREF_KEY_FLAGS)) return
        val old = try {
            existingKey() ?: return // the next getOrCreateKey makes a flagged key
        } catch (e: Exception) {
            return // set's own error handling deals with a broken key
        }
        val values = HashMap<String, String>()
        for (name in prefs.all.keys) {
            if (!name.startsWith("v_")) continue
            val key = name.removePrefix("v_")
            try {
                values[key] = decrypt(old, key, decode(prefs.getString("iv_$key", null)), decode(prefs.getString(name, null)))
            } catch (e: IllegalArgumentException) {
                drop(prefs, key, "bad data")
            } catch (e: Exception) {
                val kind = classify(e)
                if (kind == KeyErrors.Kind.BAD_DATA) {
                    drop(prefs, key, "AEADBadTagException")
                } else if (kind != KeyErrors.Kind.PERMANENT) {
                    Log.w(TAG, "key migration postponed: ${e.javaClass.simpleName}")
                    return
                }
            }
        }
        Log.i(TAG, "moving ${values.size} value(s) to an unlocked-device key")
        deleteKey()
        for ((key, value) in values) {
            try {
                write(prefs, key, value)
            } catch (e: Exception) {
                Log.w(TAG, "could not re-encrypt '$key': ${e.javaClass.simpleName}")
                removeEntry(prefs, key)
            }
        }
    }

    /** What a Keystore or cipher failure means ([KeyErrors]), with Android 13's own verdict. */
    private fun classify(e: Throwable): KeyErrors.Kind {
        val keystore = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            e.causeOf<android.security.KeyStoreException>()
        } else {
            null
        }
        val (transient, needsAuth) = if (keystore != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            (keystore.isTransientFailure || keystore.isSystemError) to keystore.requiresUserAuthentication()
        } else {
            null to null
        }
        return KeyErrors.classify(
            KeyErrors.Facts(
                invalidated = e.causeOf<KeyPermanentlyInvalidatedException>() != null,
                badTag = e.causeOf<AEADBadTagException>() != null,
                notAuthenticated = e.causeOf<UserNotAuthenticatedException>() != null,
                keystoreTransient = transient,
                keystoreNeedsAuth = needsAuth,
            ),
        )
    }

    private inline fun <reified T : Throwable> Throwable.causeOf(): T? {
        var t: Throwable? = this
        var depth = 0
        while (t != null && depth < 8) {
            if (t is T) return t
            t = t.cause
            depth++
        }
        return null
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

    private fun encrypt(secret: SecretKey, key: String, value: String): Pair<ByteArray, ByteArray> {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secret) // the Keystore picks a random 12-byte IV
        cipher.updateAAD(key.toByteArray(StandardCharsets.UTF_8))
        val ct = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        return cipher.iv to ct
    }

    private fun decrypt(secret: SecretKey, key: String, iv: ByteArray, ct: ByteArray): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(TAG_BITS, iv))
        cipher.updateAAD(key.toByteArray(StandardCharsets.UTF_8))
        return String(cipher.doFinal(ct), StandardCharsets.UTF_8)
    }

    /** Throws IllegalArgumentException on missing data or bad base64. */
    private fun decode(s: String?): ByteArray {
        if (s.isNullOrEmpty()) throw IllegalArgumentException("missing data")
        return Base64.decode(s, Base64.NO_WRAP)
    }

    private fun removeEntry(prefs: SharedPreferences, key: String) {
        if (!prefs.edit().remove("v_$key").remove("iv_$key").commit()) {
            Log.w(TAG, "could not remove '$key': disk write failed")
        }
    }

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? = keyStore().getKey(ALIAS, null) as? SecretKey

    /** The key, or a new one, recorded in [PREF_KEY_FLAGS] (so [migrateKey] leaves it alone). */
    private fun getOrCreateKey(prefs: SharedPreferences): SecretKey {
        existingKey()?.let { return it }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                return generateKey(unlockedDeviceRequired = true).also { markKey(prefs, "unlocked") }
            } catch (e: Exception) {
                // Some devices refuse the flag (e.g. no secure lock screen): fall back.
                Log.w(TAG, "unlocked-device key unavailable: ${e.javaClass.simpleName}")
            }
        }
        return generateKey(unlockedDeviceRequired = false).also { markKey(prefs, "plain") }
    }

    private fun markKey(prefs: SharedPreferences, flags: String) {
        prefs.edit().putString(PREF_KEY_FLAGS, flags).commit()
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

/**
 * What a Keystore or cipher failure means for a stored value, as a pure function
 * (KeyErrorsTest). Permanent only when it really is: an UnrecoverableKeyException on its own is
 * not, because Keystore2 (Android 12+) also wraps busy and system errors in it.
 */
internal object KeyErrors {
    enum class Kind {
        /** The key can never work again: drop what it protects and make a new one. */
        PERMANENT,

        /** Tampered data, or data of another key: drop that value. */
        BAD_DATA,

        /** The device is locked (unlocked-device key): retry later, keep everything. */
        LOCKED,

        /** Busy, a system error, or unknown: retry, then reject UNAVAILABLE and keep the value. */
        TRANSIENT,
    }

    data class Facts(
        /** KeyPermanentlyInvalidatedException in the cause chain. */
        val invalidated: Boolean = false,
        /** AEADBadTagException in the cause chain. */
        val badTag: Boolean = false,
        /** UserNotAuthenticatedException in the cause chain (a locked device before Android 13). */
        val notAuthenticated: Boolean = false,
        /** Android 13+: the chain's KeyStoreException is transient or a system error; null if none. */
        val keystoreTransient: Boolean? = null,
        /** Android 13+: the chain's KeyStoreException needs the user (locked); null if none. */
        val keystoreNeedsAuth: Boolean? = null,
    )

    fun classify(f: Facts): Kind = when {
        f.invalidated -> Kind.PERMANENT
        f.badTag -> Kind.BAD_DATA
        f.notAuthenticated || f.keystoreNeedsAuth == true -> Kind.LOCKED
        f.keystoreTransient == true -> Kind.TRANSIENT
        // Android 13+ says it is neither transient nor about the user: a corrupt or missing key
        // blob (e.g. after an OS update or a restore).
        f.keystoreTransient == false -> Kind.PERMANENT
        else -> Kind.TRANSIENT
    }
}
