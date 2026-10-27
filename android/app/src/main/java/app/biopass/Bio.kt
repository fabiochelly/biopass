package app.biopass

import android.app.Activity
import android.content.pm.PackageManager
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import app.biopass.core.Crypto
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Déverrouillage par empreinte : la clé brute du coffre (+ l'auth, pour obtenir un nouveau
 * token sans mot de passe) est chiffrée par une clé AES du Keystore Android qui exige une
 * authentification biométrique forte à chaque usage et qui est invalidée si une nouvelle
 * empreinte est enregistrée.
 */
object Bio {
    private const val ALIAS = "biopass_bio"
    private val file get() = File(Session.app.filesDir, "bio.json")

    val enabled get() = file.exists()

    fun available(): Boolean {
        val ctx = Session.app
        return when {
            Build.VERSION.SDK_INT >= 30 -> ctx.getSystemService(BiometricManager::class.java)
                .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
            Build.VERSION.SDK_INT == 29 -> @Suppress("DEPRECATION")
                ctx.getSystemService(BiometricManager::class.java).canAuthenticate() == BiometricManager.BIOMETRIC_SUCCESS
            else -> ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)
        }
    }

    fun disable() {
        file.delete()
        try {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS)
        } catch (e: Exception) { /* rien */ }
    }

    private fun newKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        ks.deleteEntry(ALIAS)
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .apply {
                if (Build.VERSION.SDK_INT >= 30) setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            }
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run { init(spec); generateKey() }
    }

    private fun existingKey(): SecretKey? {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return ks.getKey(ALIAS, null) as SecretKey?
    }

    private fun prompt(act: Activity, title: String, cipher: Cipher, onOk: (Cipher) -> Unit, onErr: (String?) -> Unit) {
        val exec = act.mainExecutor
        val b = BiometricPrompt.Builder(act)
            .setTitle(title)
            .setSubtitle(Session.vault.profile?.user ?: "")
            .setNegativeButton("Mot de passe", exec) { _, _ -> onErr(null) }
        if (Build.VERSION.SDK_INT >= 30) b.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        if (Build.VERSION.SDK_INT >= 29) b.setConfirmationRequired(false)
        b.build().authenticate(BiometricPrompt.CryptoObject(cipher), CancellationSignal(), exec,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val c = result.cryptoObject?.cipher
                    if (c == null) onErr("Authentification biométrique invalide") else onOk(c)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence?) {
                    val silent = errorCode == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED ||
                        errorCode == BiometricPrompt.BIOMETRIC_ERROR_CANCELED
                    onErr(if (silent) null else errString?.toString())
                }
            })
    }

    /** Active l'empreinte (coffre déverrouillé). [done] reçoit un message d'erreur ou null. */
    fun enable(act: Activity, done: (String?) -> Unit) {
        val v = Session.vault
        val raw = v.rawKey()
        val auth = v.auth
        val p = v.profile
        if (raw == null || auth == null || p == null) return done("Déverrouillez d'abord le coffre")
        val cipher = try {
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, newKey()) }
        } catch (e: Exception) {
            return done("Empreinte indisponible : enregistrez une empreinte dans les paramètres du téléphone")
        }
        prompt(act, "Activer l'empreinte", cipher, { c ->
            try {
                val plain = JSONObject().put("k", Crypto.b64(raw)).put("a", auth).toString().toByteArray()
                val ct = c.doFinal(plain)
                plain.fill(0)
                val out = JSONObject().put("iv", Crypto.b64(c.iv)).put("ct", Crypto.b64(ct)).put("server", p.server).put("user", p.user)
                file.writeText(out.toString())
                done(null)
            } catch (e: Exception) {
                done("Échec de l'activation de l'empreinte")
            } finally {
                raw.fill(0)
            }
        }, { msg -> raw.fill(0); done(msg ?: "Activation annulée") })
    }

    class Secrets(val raw: ByteArray, val auth: String)

    /**
     * Déchiffre la clé après authentification biométrique.
     * [done] reçoit les secrets, ou null + message (null si annulé par l'utilisateur).
     */
    fun unlock(act: Activity, done: (Secrets?, String?) -> Unit) {
        val stored = try {
            JSONObject(file.readText())
        } catch (e: Exception) {
            return done(null, "Empreinte non configurée")
        }
        val p = Session.vault.profile
        if (p == null || stored.optString("user") != p.user || stored.optString("server") != p.server) {
            disable()
            return done(null, "Empreinte non configurée pour ce compte")
        }
        val cipher = try {
            val key = existingKey() ?: throw KeyPermanentlyInvalidatedException()
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Crypto.unb64(stored.getString("iv"))))
            }
        } catch (e: KeyPermanentlyInvalidatedException) {
            disable()
            return done(null, "Les empreintes du téléphone ont changé : déverrouillez avec le mot de passe puis réactivez l'empreinte")
        } catch (e: Exception) {
            disable()
            return done(null, "Empreinte indisponible : utilisez le mot de passe")
        }
        prompt(act, "Déverrouiller BioPass", cipher, { c ->
            try {
                val plain = c.doFinal(Crypto.unb64(stored.getString("ct")))
                val o = JSONObject(String(plain))
                plain.fill(0)
                done(Secrets(Crypto.unb64(o.getString("k")), o.getString("a")), null)
            } catch (e: Exception) {
                done(null, "Échec du déchiffrement : utilisez le mot de passe")
            }
        }, { msg -> done(null, msg) })
    }
}
