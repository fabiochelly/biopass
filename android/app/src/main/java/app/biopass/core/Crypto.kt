package app.biopass.core

import java.security.SecureRandom
import java.text.Normalizer
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Cryptographie BioPass (voir PROTOCOL.md §1). Kotlin pur : testable sur la JVM. */
object Crypto {
    const val DEFAULT_ITER = 600_000
    private val rng = SecureRandom()

    fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    fun unb64(s: String): ByteArray = Base64.getDecoder().decode(s)

    fun randomBytes(n: Int) = ByteArray(n).also { rng.nextBytes(it) }
    fun newId(): String = randomBytes(16).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    class Keys(val auth: String, val wrapKey: ByteArray)

    /** Mot de passe maître → auth (b64, envoyé au serveur) + wrapKey. */
    fun deriveKeys(password: String, saltB64: String, iter: Int): Keys {
        val pw = Normalizer.normalize(password, Normalizer.Form.NFC).toByteArray(Charsets.UTF_8)
        val master = Pbkdf2.sha256(pw, unb64(saltB64), iter)
        pw.fill(0)
        val auth = b64(hkdf(master, "biopass/auth"))
        val wrap = hkdf(master, "biopass/wrap")
        master.fill(0)
        return Keys(auth, wrap)
    }

    /** HKDF-SHA256 (RFC 5869), sel vide, 32 octets. */
    fun hkdf(ikm: ByteArray, info: String): ByteArray {
        val prk = hmac(ByteArray(32), ikm)
        return hmac(prk, info.toByteArray(Charsets.UTF_8) + byteArrayOf(1))
    }

    fun hmac(key: ByteArray, data: ByteArray, algo: String = "HmacSHA256"): ByteArray =
        Mac.getInstance(algo).run { init(SecretKeySpec(key, algo)); doFinal(data) }

    fun seal(key: ByteArray, plain: ByteArray, aad: String): String {
        val iv = randomBytes(12)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        c.updateAAD(aad.toByteArray(Charsets.UTF_8))
        return b64(iv + c.doFinal(plain))
    }

    /** Lève [AEADBadTagException] (ou une autre GeneralSecurityException) si le chiffré est invalide. */
    fun open(key: ByteArray, data: String, aad: String): ByteArray {
        val raw = unb64(data)
        require(raw.size >= 28) { "Chiffré trop court" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, raw, 0, 12))
        c.updateAAD(aad.toByteArray(Charsets.UTF_8))
        return c.doFinal(raw, 12, raw.size - 12)
    }

    fun wrapVaultKey(wrapKey: ByteArray, raw: ByteArray) = seal(wrapKey, raw, "biopass/vaultkey")

    fun unwrapVaultKey(wrapKey: ByteArray, wrapped: String): ByteArray = try {
        open(wrapKey, wrapped, "biopass/vaultkey")
    } catch (e: Exception) {
        throw BadPasswordException()
    }

    fun encryptItem(vaultKey: ByteArray, id: String, json: String) =
        seal(vaultKey, json.toByteArray(Charsets.UTF_8), "biopass/item/$id")

    fun decryptItem(vaultKey: ByteArray, id: String, enc: String) =
        String(open(vaultKey, enc, "biopass/item/$id"), Charsets.UTF_8)
}

class BadPasswordException : Exception("Mot de passe incorrect")

/**
 * PBKDF2-HMAC-SHA256 écrit à la main : encodage UTF-8 garanti (les fournisseurs Android
 * diffèrent sur la conversion char → octets) et rapide (états HMAC précalculés, SHA-256
 * sur des blocs fixes, aucune allocation dans la boucle de 600 000 itérations).
 */
object Pbkdf2 {
    private val K = intArrayOf(
        0x428a2f98, 0x71374491, -0x4a3f0431, -0x164a245b, 0x3956c25b, 0x59f111f1, -0x6dc07d5c, -0x54e3a12b,
        -0x27f85568, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, -0x7f214e02, -0x6423f959, -0x3e640e8c,
        -0x1b64963f, -0x1041b87a, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        -0x67c1aeae, -0x57ce3993, -0x4ffcd838, -0x40a68039, -0x391ff40d, -0x2a586eb9, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, -0x7e3d36d2, -0x6d8dd37b,
        -0x5d40175f, -0x57e599b5, -0x3db47490, -0x3893ae5d, -0x2e6d17e7, -0x2966f9dc, -0xbf1ca7b, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, -0x7b3787ec, -0x7338fdf8, -0x6f410006, -0x5baf9315, -0x41065c09, -0x398e870e,
    )
    private val H0 = intArrayOf(
        0x6a09e667, -0x4498517b, 0x3c6ef372, -0x5ab00ac6, 0x510e527f, -0x64fa9774, 0x1f83d9ab, 0x5be0cd19,
    )

    /** Compresse un bloc de 16 mots (w[0..15]) dans l'état h (8 mots). w est écrasé (64 mots). */
    private fun compress(h: IntArray, w: IntArray) {
        for (t in 16 until 64) {
            val x = w[t - 15]
            val y = w[t - 2]
            val s0 = Integer.rotateRight(x, 7) xor Integer.rotateRight(x, 18) xor (x ushr 3)
            val s1 = Integer.rotateRight(y, 17) xor Integer.rotateRight(y, 19) xor (y ushr 10)
            w[t] = w[t - 16] + s0 + w[t - 7] + s1
        }
        var a = h[0]; var b = h[1]; var c = h[2]; var d = h[3]
        var e = h[4]; var f = h[5]; var g = h[6]; var hh = h[7]
        for (t in 0 until 64) {
            val s1 = Integer.rotateRight(e, 6) xor Integer.rotateRight(e, 11) xor Integer.rotateRight(e, 25)
            val ch = (e and f) xor (e.inv() and g)
            val t1 = hh + s1 + ch + K[t] + w[t]
            val s0 = Integer.rotateRight(a, 2) xor Integer.rotateRight(a, 13) xor Integer.rotateRight(a, 22)
            val maj = (a and b) xor (a and c) xor (b and c)
            val t2 = s0 + maj
            hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh
    }

    /** État SHA-256 après un bloc de clé XOR pad (ipad/opad). */
    private fun padState(key: ByteArray, pad: Int): IntArray {
        val h = H0.copyOf()
        val w = IntArray(64)
        for (i in 0 until 16) {
            var v = 0
            for (j in 0 until 4) {
                val idx = i * 4 + j
                val kb = if (idx < key.size) key[idx].toInt() and 0xff else 0
                v = (v shl 8) or (kb xor pad)
            }
            w[i] = v
        }
        compress(h, w)
        return h
    }

    /** HMAC d'un message de 32 octets (8 mots) à partir des états précalculés ; résultat dans out. */
    private fun hmac32(inner: IntArray, outer: IntArray, msg: IntArray, out: IntArray, w: IntArray, st: IntArray) {
        // Bloc interne : 32 octets de message + padding (longueur totale 64 + 32 = 96 octets = 768 bits)
        System.arraycopy(inner, 0, st, 0, 8)
        System.arraycopy(msg, 0, w, 0, 8)
        w[8] = -0x80000000; w[9] = 0; w[10] = 0; w[11] = 0; w[12] = 0; w[13] = 0; w[14] = 0; w[15] = 768
        compress(st, w)
        System.arraycopy(st, 0, w, 0, 8)
        System.arraycopy(outer, 0, st, 0, 8)
        w[8] = -0x80000000; w[9] = 0; w[10] = 0; w[11] = 0; w[12] = 0; w[13] = 0; w[14] = 0; w[15] = 768
        compress(st, w)
        System.arraycopy(st, 0, out, 0, 8)
    }

    /** PBKDF2-HMAC-SHA256 avec une sortie de 32 octets (un seul bloc). */
    fun sha256(password: ByteArray, salt: ByteArray, iter: Int): ByteArray {
        require(iter >= 1)
        val key = if (password.size > 64) java.security.MessageDigest.getInstance("SHA-256").digest(password) else password
        val inner = padState(key, 0x36)
        val outer = padState(key, 0x5c)
        // U1 = HMAC(P, salt || INT(1)) : longueur quelconque, via javax.crypto
        val u1 = Crypto.hmac(password, salt + byteArrayOf(0, 0, 0, 1))
        val u = IntArray(8)
        for (i in 0 until 8) {
            u[i] = ((u1[i * 4].toInt() and 0xff) shl 24) or ((u1[i * 4 + 1].toInt() and 0xff) shl 16) or
                ((u1[i * 4 + 2].toInt() and 0xff) shl 8) or (u1[i * 4 + 3].toInt() and 0xff)
        }
        val acc = u.copyOf()
        val w = IntArray(64)
        val st = IntArray(8)
        for (n in 1 until iter) {
            hmac32(inner, outer, u, u, w, st)
            for (i in 0 until 8) acc[i] = acc[i] xor u[i]
        }
        val out = ByteArray(32)
        for (i in 0 until 8) {
            out[i * 4] = (acc[i] ushr 24).toByte(); out[i * 4 + 1] = (acc[i] ushr 16).toByte()
            out[i * 4 + 2] = (acc[i] ushr 8).toByte(); out[i * 4 + 3] = acc[i].toByte()
        }
        return out
    }
}
