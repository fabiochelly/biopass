package app.biopass.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/** Vecteurs de test générés par core.js (tools/make-vectors.mjs). */
class CoreTest {
    private val v = JSONObject(javaClass.getResource("/test-vectors.json")!!.readText())

    @Test fun authIdentique() {
        val t = System.nanoTime()
        val k = Crypto.deriveKeys(v.getString("password"), v.getString("salt"), v.getInt("iter"))
        println("PBKDF2 600 000 itérations : ${(System.nanoTime() - t) / 1_000_000} ms")
        assertEquals(v.getString("auth"), k.auth)
    }

    @Test fun pbkdf2CommeLaJvm() {
        // Comparaison avec l'implémentation SunJCE (UTF-8) sur des mots de passe variés, dont > 64 octets.
        for (pw in listOf("a", "Crème brûlée 42!", "x".repeat(64), "é".repeat(50), "")) {
            val salt = Crypto.randomBytes(16)
            val ref = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
                .generateSecret(PBEKeySpec(pw.toCharArray(), salt, 1000, 256)).encoded
            if (pw.isEmpty()) continue // SunJCE refuse les mots de passe vides
            assertEquals(pw, Crypto.b64(ref), Crypto.b64(Pbkdf2.sha256(pw.toByteArray(), salt, 1000)))
        }
        // RFC 7914 §11 : PBKDF2-HMAC-SHA256("passwd", "salt", 1) (64 octets → 32 premiers)
        assertEquals("55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc",
            Pbkdf2.sha256("passwd".toByteArray(), "salt".toByteArray(), 1).joinToString("") { "%02x".format(it) })
    }

    @Test fun dechiffrementWrapped() {
        val k = Crypto.deriveKeys(v.getString("password"), v.getString("salt"), v.getInt("iter"))
        val raw = Crypto.unwrapVaultKey(k.wrapKey, v.getString("wrapped"))
        assertEquals(v.getString("vaultKeyRawB64"), Crypto.b64(raw))
        val bad = Crypto.deriveKeys("mauvais", v.getString("salt"), 1000)
        try {
            Crypto.unwrapVaultKey(bad.wrapKey, v.getString("wrapped")); fail()
        } catch (e: BadPasswordException) {
            assertEquals("Mot de passe incorrect", e.message)
        }
    }

    @Test fun dechiffrementEntree() {
        val raw = Crypto.unb64(v.getString("vaultKeyRawB64"))
        val id = v.getString("itemId")
        val obj = JSONObject(Crypto.decryptItem(raw, id, v.getString("itemEnc")))
        val exp = v.getJSONObject("item")
        assertEquals(exp.keySet(), obj.keySet())
        for (key in exp.keySet()) assertEquals(key, exp.get(key).toString(), obj.get(key).toString())
        val it = Item(id, 1, obj)
        assertEquals("é", it.notes)
        assertEquals(listOf("https://example.com"), it.uris)
        // AAD liée à l'id : un autre id ne déchiffre pas
        try {
            Crypto.decryptItem(raw, "f".repeat(32), v.getString("itemEnc")); fail()
        } catch (e: Exception) { /* attendu */ }
    }

    @Test fun allerRetour() {
        val raw = Crypto.randomBytes(32)
        val id = Crypto.newId()
        assertTrue(id.matches(Regex("[0-9a-f]{32}")))
        val json = JSONObject().put("name", "Ünïcødé ✓").put("inconnu", JSONObject().put("x", 1)).toString()
        val enc = Crypto.encryptItem(raw, id, json)
        assertEquals(json, Crypto.decryptItem(raw, id, enc))
        assertNotEquals(enc, Crypto.encryptItem(raw, id, json)) // IV aléatoire
        val wk = Crypto.randomBytes(32)
        val w = Crypto.wrapVaultKey(wk, raw)
        assertEquals(60, Crypto.unb64(w).size)
        assertEquals(Crypto.b64(raw), Crypto.b64(Crypto.unwrapVaultKey(wk, w)))
    }

    @Test fun totp() {
        val arr = v.getJSONArray("totp")
        for (i in 0 until arr.length()) {
            val t = arr.getJSONObject(i)
            assertEquals(t.getString("code"), Totp.code(t.getString("secret"), t.getLong("timeMs")).code)
        }
        assertEquals(20, Totp.code("JBSWY3DPEHPK3PXP", 10_000).remaining)
        // RFC 6238 (SHA1, 8 chiffres, t = 59 s)
        assertEquals("94287082", Totp.code("otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8", 59_000).code)
        assertEquals(null, Totp.codeOrNull("pas base32 !"))
    }

    @Test fun baseDomain() {
        val arr = v.getJSONArray("baseDomain")
        for (i in 0 until arr.length()) {
            val p = arr.getJSONArray(i)
            assertEquals(p.getString(1), Domains.baseDomain(p.getString(0)))
        }
        assertEquals("github.com", Domains.hostOf("github.com/login"))
        assertEquals("www.github.com", Domains.hostOf("https://user:pw@WWW.GitHub.com:8443/x?y#z"))
        assertEquals("", Domains.hostOf("localhost:8080"))
        assertEquals("com.example.app", Domains.hostOf("androidapp://com.example.app"))
        val it = Item("x", 1, JSONObject().put("uris", org.json.JSONArray(listOf("github.com", "androidapp://com.github.android"))))
        assertTrue(Domains.matchesUrl(it, "https://gist.github.com/a"))
        assertFalse(Domains.matchesUrl(it, "https://gitlab.com"))
        assertTrue(Domains.matchesWebDomain(it, "www.github.com"))
        assertTrue(Domains.matchesApp(it, "com.github.android"))
        assertFalse(Domains.matchesApp(it, "com.github"))
    }

    @Test fun rechercheEtGenerateur() {
        fun item(name: String, fav: Boolean = false, user: String = "") =
            Item(name, 1, JSONObject().put("name", name).put("fav", fav).put("username", user))
        val items = listOf(item("Banque"), item("GitHub", user = "fab"), item("Gmail", fav = true), item("Amazon"))
        assertEquals(listOf("Gmail", "Amazon", "Banque", "GitHub"), Search.search(items, "").map { it.name })
        assertEquals(listOf("Gmail", "GitHub"), Search.search(items, "g").map { it.name })
        assertEquals(listOf("GitHub"), Search.search(items, "git fab").map { it.name })
        repeat(50) {
            val pw = PasswordGen.generate()
            assertEquals(20, pw.length)
            assertTrue(pw.any { it.isLowerCase() } && pw.any { it.isUpperCase() } && pw.any { it.isDigit() } && pw.any { !it.isLetterOrDigit() })
        }
        assertTrue(PasswordGen.generate(8, upper = false, digits = false, symbols = false).all { it in 'a'..'z' })
    }
}

class HistoryTest {
    @Test fun historique() {
        val prev = Item("a", 1, JSONObject().put("password", "v1"))
        // Inchangé → pas d'historique
        assertFalse(withHistory(prev, JSONObject().put("password", "v1")).has("history"))
        // Pas d'ancien mot de passe → rien
        assertFalse(withHistory(Item("b", 1, JSONObject()), JSONObject().put("password", "x")).has("history"))
        assertFalse(withHistory(null, JSONObject().put("password", "x")).has("history"))
        var cur = prev
        for (n in 2..13) {
            cur = Item("a", n.toLong(), withHistory(cur, cur.copyData().put("password", "v$n"), now = n * 1000L))
        }
        val h = cur.history
        assertEquals(10, h.size)
        assertEquals("v12", h[0].password)
        assertEquals(13_000L, h[0].date)
        assertEquals("v3", h[9].password)
        assertEquals("v13", cur.password)
    }
}

class ServerTest {
    private fun p(s: String) = Server.parse(s).let { it.base to it.key }

    @Test fun parseServer() {
        assertEquals("https://example.com/biopass" to "ab-12", p("https://example.com/biopass/?k=ab-12"))
        assertEquals("https://example.com/biopass" to "", p("example.com/biopass"))
        assertEquals("https://x.fr/biopass" to "1", p("https://x.fr/biopass/index.html?k=1"))
        assertEquals("https://x.fr/biopass" to "", p(" https://x.fr/biopass/api.php "))
        assertEquals("https://x.fr" to "", p("https://X.fr:443/"))
        assertEquals("http://127.0.0.1:8782" to "cle test", p("http://127.0.0.1:8782/?a=1&k=cle+test"))
        assertEquals("." to "", p(""))
    }

    @Test fun normEtWebUrl() {
        assertEquals("https://example.com/biopass/?k=ab-12", Server.norm("example.com/biopass/index.html?k=ab-12"))
        assertEquals("https://example.com/biopass", Server.norm("https://example.com/biopass/"))
        assertEquals("https://x.fr/b/?k=a%20b%2F%C3%A9", Server.norm("https://x.fr/b?k=a%20b%2F%C3%A9"))
        assertEquals("https://x.fr/b/?k=1", Server.webUrl("https://x.fr/b/?k=1"))
        assertEquals("https://x.fr/b/", Server.webUrl("https://x.fr/b"))
        assertEquals("https://x.fr/b", Server.display("https://x.fr/b/?k=secret"))
    }

    @Test fun enTeteCle() {
        val seen = java.util.concurrent.ConcurrentHashMap<String, String>()
        val ss = java.net.ServerSocket(0, 10, java.net.InetAddress.getByName("127.0.0.1"))
        val th = Thread {
            while (!ss.isClosed) {
                val c = try { ss.accept() } catch (e: Exception) { break }
                c.use { sock ->
                    val r = sock.getInputStream().bufferedReader()
                    val first = r.readLine() ?: return@use
                    var key = "(aucune)"
                    while (true) {
                        val l = r.readLine() ?: break
                        if (l.isEmpty()) break
                        if (l.lowercase().startsWith("x-bp-key:")) key = l.substringAfter(':').trim()
                    }
                    seen["key"] = key
                    seen["path"] = first.split(' ')[1]
                    val ok = key == "cle-1"
                    val body = if (ok) "{\"salt\":\"AA==\",\"iter\":1}" else "{\"error\":\"Introuvable\"}"
                    val bytes = body.toByteArray()
                    sock.getOutputStream().write(("HTTP/1.1 ${if (ok) "200 OK" else "404 Not Found"}\r\nContent-Type: application/json\r\n" +
                        "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray() + bytes)
                }
            }
        }.apply { isDaemon = true; start() }
        try {
            val base = "http://127.0.0.1:${ss.localPort}/biopass"
            assertEquals(1, Api("$base/?k=cle-1").prelogin("u").getInt("iter"))
            assertEquals("cle-1", seen["key"])
            assertEquals("/biopass/api.php?a=prelogin", seen["path"])
            try {
                Api(base).prelogin("u"); fail()
            } catch (e: ApiError) {
                assertEquals(404, e.status)
            }
            assertEquals("(aucune)", seen["key"])
        } finally {
            ss.close()
            th.join(1000)
        }
    }
}

class IconTest {
    // PNG 1×1 transparent
    private val png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

    @Test fun icone() {
        val it = Item("a", 1, JSONObject().put("name", "GitHub").put("icon", "data:image/png;base64,$png").put("iconTry", 0))
        val bytes = it.iconBytes()!!
        assertEquals(0x89.toByte(), bytes[0]); assertEquals('P'.code.toByte(), bytes[1])
        assertEquals(null, Item("b", 1, JSONObject().put("icon", "https://x/icon.png")).icon)
        assertEquals(null, Item("c", 1, JSONObject().put("icon", "data:image/png;base64,***")).iconBytes())
        assertEquals(null, Item("d", 1, JSONObject()).icon)
    }

    @Test fun conserveeOuRetiree() {
        val prev = Item("a", 3, JSONObject().put("name", "GitHub").put("password", "x").put("uris", JSONArray(listOf("https://github.com")))
            .put("icon", "data:image/png;base64,$png").put("iconTry", 123))
        // modification du mot de passe : icon/iconTry conservés (champs non affichés préservés)
        val edited = dropIconIfUrisChanged(prev.uris, withHistory(prev, prev.copyData().put("password", "y")))
        assertEquals("data:image/png;base64,$png", edited.getString("icon"))
        assertEquals(123, edited.getInt("iconTry"))
        // mêmes adresses aux espaces près : conservée
        assertTrue(dropIconIfUrisChanged(prev.uris, prev.copyData().put("uris", JSONArray(listOf(" https://github.com ")))).has("icon"))
        // adresse changée : icon et iconTry retirés, le reste intact
        val moved = dropIconIfUrisChanged(prev.uris, prev.copyData().put("uris", JSONArray(listOf("https://gitlab.com"))))
        assertFalse(moved.has("icon")); assertFalse(moved.has("iconTry"))
        assertEquals("x", moved.getString("password"))
    }
}
