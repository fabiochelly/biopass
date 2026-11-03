package app.biopass.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/** Authentificateur WebAuthn (clés d'accès) : signatures vérifiées par la JVM, compatibilité avec core.js. */
class PasskeysTest {
    private val v = JSONObject(javaClass.getResource("/test-vectors.json")!!.readText())
    private fun spki(b64u: String): PublicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(WebAuthn.unb64u(b64u)))

    private fun verify(pub: PublicKey, json: String, clientDataHash: ByteArray? = null): Boolean {
        val r = JSONObject(json).getJSONObject("response")
        val cd = WebAuthn.unb64u(r.getString("clientDataJSON"))
        return Signature.getInstance("SHA256withECDSA").run {
            initVerify(pub)
            update(WebAuthn.unb64u(r.getString("authenticatorData")))
            update(clientDataHash ?: WebAuthn.sha256(cd))
            verify(WebAuthn.unb64u(r.getString("signature")))
        }
    }

    @Test fun creationPuisConnexion() {
        val c = WebAuthn.create("boursobank.com", "BoursoBank", "AQID", "fabio", "Fabio", "Y2hhbA", "https://clients.boursobank.com", null, null, uv = true)
        val o = JSONObject(c.responseJson)
        val r = o.getJSONObject("response")
        assertEquals(c.passkey.credentialId, o.getString("id"))
        assertEquals(true, o.getJSONObject("clientExtensionResults").getJSONObject("credProps").getBoolean("rk"))
        val ad = WebAuthn.unb64u(r.getString("authenticatorData"))
        assertArrayEquals(WebAuthn.sha256("boursobank.com".toByteArray()), ad.copyOfRange(0, 32))
        assertEquals(0x5d, ad[32].toInt() and 255) // UP UV BE BS AT
        // objet d'attestation : {fmt: "none", attStmt: {}, authData}
        val att = WebAuthn.unb64u(r.getString("attestationObject"))
        assertEquals("a363666d74646e6f6e65", att.copyOfRange(0, 10).joinToString("") { "%02x".format(it) })
        assertArrayEquals(ad, att.copyOfRange(att.size - ad.size, att.size))
        val cd = JSONObject(String(WebAuthn.unb64u(r.getString("clientDataJSON"))))
        assertEquals("webauthn.create", cd.getString("type"))
        assertEquals("https://clients.boursobank.com", cd.getString("origin"))

        val s = WebAuthn.assert(c.passkey, "Y2hhbDI", "https://clients.boursobank.com", null, null, uv = true)
        assertTrue(verify(spki(r.getString("publicKey")), s.responseJson))
        assertEquals(0L, s.counter)
        assertEquals("AQID", JSONObject(s.responseJson).getJSONObject("response").getString("userHandle"))
    }

    @Test fun navigateurFournitLeHash() {
        val c = WebAuthn.create("example.com", "", "AQ", "u", "", "Y2g", "https://example.com", null, null, uv = false)
        val hash = WebAuthn.sha256("clientDataJSON du navigateur".toByteArray())
        val s = WebAuthn.assert(c.passkey, "Y2g", "https://example.com", null, hash, uv = false)
        val pub = spki(JSONObject(c.responseJson).getJSONObject("response").getString("publicKey"))
        assertTrue(verify(pub, s.responseJson, hash))
        val ad = WebAuthn.unb64u(JSONObject(s.responseJson).getJSONObject("response").getString("authenticatorData"))
        assertEquals(0x19, ad[32].toInt() and 255) // sans UV
    }

    @Test fun cleCreeeParCoreJs() {
        val js = v.getJSONObject("passkey")
        val pk = Passkey.from(js.getJSONObject("passkey"))!!
        val s = WebAuthn.assert(pk, "Y2hhbA", "android:apk-key-hash:abc", "app.test", null, uv = true)
        assertTrue(verify(spki(js.getString("publicKey")), s.responseJson))
        val cd = JSONObject(String(WebAuthn.unb64u(JSONObject(s.responseJson).getJSONObject("response").getString("clientDataJSON"))))
        assertEquals("app.test", cd.getString("androidPackageName"))
        // compteur importé (Bitwarden) : incrémenté et inscrit dans authenticatorData
        val s2 = WebAuthn.assert(pk.withCounter(5), "Y2hhbA", "https://example.com", null, null, uv = true)
        assertEquals(6L, s2.counter)
        val ad = WebAuthn.unb64u(JSONObject(s2.responseJson).getJSONObject("response").getString("authenticatorData"))
        assertEquals(6, ad[36].toInt())
    }

    @Test fun entreeEtJson() {
        val js = v.getJSONObject("passkey").getJSONObject("passkey")
        val it = Item("x", 1, JSONObject().put("passkeys", JSONArray().put(js).put(JSONObject().put("rpId", "incomplet"))))
        assertEquals(1, it.passkeys.size)
        assertEquals(js.getString("credentialId"), Passkey.from(it.passkeys[0].toJson())!!.credentialId)
    }

    @Test fun rpId() {
        assertTrue(WebAuthn.rpIdAllowed("boursobank.com", "https://clients.boursobank.com"))
        assertTrue(WebAuthn.rpIdAllowed("clients.boursobank.com", "https://clients.boursobank.com:443"))
        assertFalse(WebAuthn.rpIdAllowed("com", "https://boursobank.com"))
        assertFalse(WebAuthn.rpIdAllowed("evil.com", "https://boursobank.com"))
        assertFalse(WebAuthn.rpIdAllowed("boursobank.com", "http://boursobank.com"))
        assertFalse(WebAuthn.rpIdAllowed("co.uk", "https://bank.co.uk"))
        assertTrue(WebAuthn.rpIdAllowed("bank.co.uk", "https://www.bank.co.uk"))
    }

    @Test fun clientDataEchappe() {
        val cd = String(WebAuthn.clientData("webauthn.get", "a\"b", "https://x", null))
        assertEquals("{\"type\":\"webauthn.get\",\"challenge\":\"a\\\"b\",\"origin\":\"https://x\",\"crossOrigin\":false}", cd)
    }

    @Test fun assetLinks() {
        val fp = ByteArray(32) { it.toByte() }
        val hex = fp.joinToString(":") { "%02X".format(it) }
        fun links(rel: String, pkg: String, f: String) = """[{"relation":["$rel"],"target":{"namespace":"android_app","package_name":"$pkg","sha256_cert_fingerprints":["$f"]}}]"""
        assertTrue(AssetLinks.allows(links("delegate_permission/common.get_login_creds", "com.bank", hex), "com.bank", fp))
        assertTrue(AssetLinks.allows(links("delegate_permission/common.handle_all_urls", "com.bank", hex.lowercase()), "com.bank", fp))
        assertFalse(AssetLinks.allows(links("delegate_permission/common.get_login_creds", "com.evil", hex), "com.bank", fp))
        assertFalse(AssetLinks.allows(links("delegate_permission/common.get_login_creds", "com.bank", hex.replace("1F", "AA")), "com.bank", fp))
        assertFalse(AssetLinks.allows(links("autre", "com.bank", hex), "com.bank", fp))
        assertFalse(AssetLinks.allows("<html>", "com.bank", fp))
    }
}
