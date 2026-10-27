package app.biopass

import android.security.keystore.KeyGenParameterSpec
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
 * Option « ne jamais verrouiller » : la clé brute du coffre et l'auth sont conservées, chiffrées
 * par une clé du Keystore Android liée à l'appareil (non exportable) mais SANS authentification
 * de l'utilisateur, pour rouvrir le coffre seul après la mort du processus ou un redémarrage.
 * Effacé par tout verrouillage manuel, un changement de délai ou un changement de compte.
 */
object Keep {
    private const val ALIAS = "biopass_keep"
    private val file get() = File(Session.app.filesDir, "keep.json")

    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun key(create: Boolean): SecretKey? {
        (keyStore().getKey(ALIAS, null) as SecretKey?)?.let { return it }
        if (!create) return null
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(false)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run { init(spec); generateKey() }
    }

    /** Enregistre la clé et l'auth du coffre déverrouillé. */
    fun save() {
        val v = Session.vault
        val raw = v.rawKey() ?: return
        val auth = v.auth ?: return
        val p = v.profile ?: return
        try {
            val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key(true)) }
            val plain = JSONObject().put("k", Crypto.b64(raw)).put("a", auth).toString().toByteArray()
            val ct = c.doFinal(plain)
            plain.fill(0)
            val tmp = File(file.path + ".tmp")
            tmp.writeText(JSONObject().put("iv", Crypto.b64(c.iv)).put("ct", Crypto.b64(ct))
                .put("server", p.server).put("user", p.user).toString())
            tmp.renameTo(file)
        } catch (e: Exception) {
            clear()
        } finally {
            raw.fill(0)
        }
    }

    /** Rouvre le coffre sans réseau si une conservation valide existe. */
    fun restore(): Boolean {
        if (!file.exists()) return false
        return try {
            val o = JSONObject(file.readText())
            val p = Session.vault.profile ?: throw IllegalStateException()
            if (o.getString("server") != p.server || o.getString("user") != p.user) throw IllegalStateException()
            val c = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key(false) ?: throw IllegalStateException(), GCMParameterSpec(128, Crypto.unb64(o.getString("iv"))))
            }
            val plain = c.doFinal(Crypto.unb64(o.getString("ct")))
            val s = JSONObject(String(plain))
            plain.fill(0)
            Session.vault.resume(Crypto.unb64(s.getString("k")), s.getString("a"))
            true
        } catch (e: Exception) {
            clear()
            false
        }
    }

    fun clear() {
        file.delete()
        try {
            keyStore().deleteEntry(ALIAS)
        } catch (e: Exception) { /* rien */ }
    }
}
