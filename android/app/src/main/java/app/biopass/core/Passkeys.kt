package app.biopass.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import java.util.Locale

// ------------------------------------------------------------------ clés d'accès (cf. core.js, PROTOCOL.md)

/** Clé d'accès rangée dans une entrée (`passkeys`), format commun avec core.js et l'import Bitwarden. */
class Passkey(
    val credentialId: String, // base64url
    val rpId: String,
    val rpName: String,
    val userHandle: String, // base64url
    val userName: String,
    val userDisplayName: String,
    val key: String, // clé privée ECDSA P-256, PKCS#8 DER en base64url
    val counter: Long,
    val created: Long,
) {
    fun toJson(): JSONObject = JSONObject().put("credentialId", credentialId).put("rpId", rpId).put("rpName", rpName)
        .put("userHandle", userHandle).put("userName", userName).put("userDisplayName", userDisplayName)
        .put("key", key).put("counter", counter).put("created", created)

    fun withCounter(c: Long) = Passkey(credentialId, rpId, rpName, userHandle, userName, userDisplayName, key, c, created)

    companion object {
        fun from(o: JSONObject?): Passkey? {
            if (o == null) return null
            fun s(k: String) = if (o.isNull(k)) "" else o.optString(k, "")
            if (s("credentialId").isEmpty() || s("rpId").isEmpty() || s("key").isEmpty()) return null
            return Passkey(s("credentialId"), s("rpId"), s("rpName"), s("userHandle"), s("userName"), s("userDisplayName"),
                s("key"), o.optLong("counter", 0), o.optLong("created", 0))
        }
    }
}

/**
 * Authentificateur logiciel WebAuthn, identique à celui de l'extension : ES256, attestation « none »,
 * drapeaux UP + BE + BS (+ UV si l'utilisateur a été vérifié). Réponses au format JSON de WebAuthn
 * (`PublicKeyCredential.toJSON()`), attendu par le Credential Manager d'Android.
 */
object WebAuthn {
    private val AAGUID = "b10b1a55b10b4a55b10b1a55b10b4a55".chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private val rng = SecureRandom()

    fun b64u(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    fun unb64u(s: String): ByteArray = Base64.getUrlDecoder().decode(s.trim().trimEnd('=').replace('+', '-').replace('/', '_'))
    fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

    /** Origine d'une application (au lieu d'une adresse web) : empreinte SHA-256 de son certificat. */
    fun appOrigin(certSha256: ByteArray) = "android:apk-key-hash:" + b64u(certSha256)

    /**
     * rpId acceptable pour une origine web : son hôte ou un domaine parent (pas plus haut que le domaine
     * de base), en HTTPS (comme `rpIdAllowed` de core.js).
     */
    fun rpIdAllowed(rpId: String, origin: String): Boolean {
        val u = try {
            java.net.URI(origin)
        } catch (e: Exception) {
            return false
        }
        val host = u.host?.lowercase(Locale.ROOT) ?: return false
        val rp = rpId.lowercase(Locale.ROOT)
        if (rp.isEmpty() || u.scheme?.lowercase(Locale.ROOT) != "https") return false
        return host == rp || (host.endsWith(".$rp") && rp.length >= Domains.baseDomain(host).length)
    }

    /** clientDataJSON, champs dans l'ordre de la spécification (vérification « limitée » des sites). */
    fun clientData(type: String, challenge: String, origin: String, androidPackage: String?): ByteArray {
        val sb = StringBuilder("{\"type\":").append(JSONObject.quote(type))
            .append(",\"challenge\":").append(JSONObject.quote(challenge))
            .append(",\"origin\":").append(JSONObject.quote(origin))
            .append(",\"crossOrigin\":false")
        if (androidPackage != null) sb.append(",\"androidPackageName\":").append(JSONObject.quote(androidPackage))
        return sb.append('}').toString().toByteArray(Charsets.UTF_8)
    }

    // CBOR minimal (entiers, octets, textes, Map) : objet d'attestation et clé publique COSE
    private fun cbor(out: ByteArrayOutputStream, v: Any) {
        fun head(major: Int, n: Long) {
            val m = major shl 5
            when {
                n < 24 -> out.write(m or n.toInt())
                n < 256 -> { out.write(m or 24); out.write(n.toInt()) }
                n < 65536 -> { out.write(m or 25); out.write((n shr 8).toInt()); out.write((n and 255).toInt()) }
                else -> { out.write(m or 26); for (s in intArrayOf(24, 16, 8, 0)) out.write(((n shr s) and 255).toInt()) }
            }
        }
        when (v) {
            is Int -> if (v >= 0) head(0, v.toLong()) else head(1, -1L - v)
            is String -> v.toByteArray(Charsets.UTF_8).let { head(3, it.size.toLong()); out.write(it) }
            is ByteArray -> { head(2, v.size.toLong()); out.write(v) }
            is Map<*, *> -> { head(5, v.size.toLong()); for ((k, x) in v) { cbor(out, k!!); cbor(out, x!!) } }
            else -> throw IllegalArgumentException("CBOR : type non géré")
        }
    }

    private fun cbor(v: Any): ByteArray = ByteArrayOutputStream().also { cbor(it, v) }.toByteArray()

    private fun authData(rpId: String, uv: Boolean, counter: Long, attested: ByteArray? = null): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(sha256(rpId.toByteArray(Charsets.UTF_8)))
        // UP 0x01 | UV 0x04 | BE 0x08 | BS 0x10 | AT 0x40
        out.write(0x19 or (if (uv) 0x04 else 0) or (if (attested != null) 0x40 else 0))
        for (s in intArrayOf(24, 16, 8, 0)) out.write(((counter shr s) and 255).toInt())
        if (attested != null) out.write(attested)
        return out.toByteArray()
    }

    private fun coord(v: BigInteger): ByteArray {
        val b = v.toByteArray().let { if (it.size > 32) it.copyOfRange(it.size - 32, it.size) else it }
        return ByteArray(32 - b.size) + b
    }

    class Created(val passkey: Passkey, val responseJson: String)

    /**
     * Nouvelle clé d'accès. [clientDataHash] : fourni par un navigateur (qui construit lui-même
     * clientDataJSON) ; sinon calculé sur le clientDataJSON produit ici avec [origin].
     */
    fun create(
        rpId: String, rpName: String, userId: String, userName: String, userDisplayName: String,
        challenge: String, origin: String, androidPackage: String?, clientDataHash: ByteArray?, uv: Boolean,
        now: Long = System.currentTimeMillis(),
    ): Created {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val pub = pair.public as ECPublicKey
        val credId = ByteArray(16).also { rng.nextBytes(it) }
        val cose = cbor(linkedMapOf<Any, Any>(1 to 2, 3 to -7, -1 to 1, -2 to coord(pub.w.affineX), -3 to coord(pub.w.affineY)))
        val attested = ByteArrayOutputStream().apply {
            write(AAGUID); write(0); write(credId.size); write(credId); write(cose)
        }.toByteArray()
        val ad = authData(rpId, uv, 0, attested)
        val attestation = cbor(linkedMapOf<Any, Any>("fmt" to "none", "attStmt" to linkedMapOf<Any, Any>(), "authData" to ad))
        val cd = clientData("webauthn.create", challenge, origin, androidPackage)
        val passkey = Passkey(b64u(credId), rpId, rpName, userId, userName, userDisplayName, b64u(pair.private.encoded), 0, now)
        val response = JSONObject()
            .put("clientDataJSON", b64u(cd))
            .put("attestationObject", b64u(attestation))
            .put("authenticatorData", b64u(ad))
            .put("transports", JSONArray(listOf("internal", "hybrid")))
            .put("publicKey", b64u(pub.encoded))
            .put("publicKeyAlgorithm", -7)
        val json = credentialJson(passkey.credentialId, response, JSONObject().put("credProps", JSONObject().put("rk", true)))
        return Created(passkey, json)
    }

    class Signed(val counter: Long, val responseJson: String)

    /** Connexion : signe authenticatorData || SHA-256(clientDataJSON). Compteur 0 = clé synchronisée (reste 0). */
    fun assert(pk: Passkey, challenge: String, origin: String, androidPackage: String?, clientDataHash: ByteArray?, uv: Boolean): Signed {
        val counter = if (pk.counter > 0) pk.counter + 1 else 0
        val ad = authData(pk.rpId, uv, counter)
        val cd = clientData("webauthn.get", challenge, origin, androidPackage)
        val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(unb64u(pk.key)))
        val sig = Signature.getInstance("SHA256withECDSA").run { // signature DER, comme l'attend WebAuthn
            initSign(key)
            update(ad)
            update(clientDataHash ?: sha256(cd))
            sign()
        }
        val response = JSONObject()
            .put("clientDataJSON", b64u(cd))
            .put("authenticatorData", b64u(ad))
            .put("signature", b64u(sig))
            .put("userHandle", pk.userHandle)
        return Signed(counter, credentialJson(pk.credentialId, response, JSONObject()))
    }

    private fun credentialJson(id: String, response: JSONObject, ext: JSONObject) = JSONObject()
        .put("id", id).put("rawId", id).put("type", "public-key").put("authenticatorAttachment", "platform")
        .put("response", response).put("clientExtensionResults", ext).toString()
}

/** Digital Asset Links : liens déclarés par un site entre lui et des applications Android. */
object AssetLinks {
    private val RELATIONS = setOf("delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls")

    /** `https://<rpId>/.well-known/assetlinks.json` autorise-t-il l'appli [pkg] signée par [certSha256] ? */
    fun allows(json: String, pkg: String, certSha256: ByteArray): Boolean {
        val fp = certSha256.joinToString(":") { "%02X".format(it) }
        val list = try {
            JSONArray(json)
        } catch (e: Exception) {
            return false
        }
        for (i in 0 until list.length()) {
            val st = list.optJSONObject(i) ?: continue
            val rel = st.optJSONArray("relation") ?: continue
            if ((0 until rel.length()).none { rel.optString(it) in RELATIONS }) continue
            val t = st.optJSONObject("target") ?: continue
            if (t.optString("namespace") != "android_app" || t.optString("package_name") != pkg) continue
            val fps = t.optJSONArray("sha256_cert_fingerprints") ?: continue
            if ((0 until fps.length()).any { fps.optString(it).equals(fp, ignoreCase = true) }) return true
        }
        return false
    }
}
