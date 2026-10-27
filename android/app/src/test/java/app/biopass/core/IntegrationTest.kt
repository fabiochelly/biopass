package app.biopass.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Test contre un vrai serveur PHP (lancé par tools/integration-test.sh).
 * Ignoré si BIOPASS_IT_SERVER n'est pas défini.
 */
class IntegrationTest {
    private fun expectStatus(status: Int, block: () -> Unit) {
        try {
            block(); fail("ApiError $status attendue")
        } catch (e: ApiError) {
            assertEquals(e.message, status, e.status)
        }
    }

    @Test fun serveurReel() {
        val server = System.getenv("BIOPASS_IT_SERVER").orEmpty()
        assumeTrue("BIOPASS_IT_SERVER non défini", server.isNotEmpty())
        val infoFile = File(System.getenv("BIOPASS_IT_INFO")!!)
        val info = JSONObject(infoFile.readText())
        val user = info.getString("user")
        val pw = info.getString("password")
        val jsId = info.getString("jsId")

        // Clé d'accès : sans elle, le serveur répond 404 à tout
        val base = Server.parse(server).base
        assertTrue(Server.parse(server).key.isNotEmpty())
        expectStatus(404) { Api(base).prelogin(user) }
        expectStatus(404) { Vault(MemoryStore()).login(base, user, pw) }
        expectStatus(404) { Vault(MemoryStore()).login("$base/?k=mauvaise", user, pw) }

        // Appareil A : connexion (identifiant en majuscules → normalisé), lecture de l'entrée créée par le JS
        val storeA = MemoryStore()
        val a = Vault(storeA)
        a.login(server, user.uppercase(), pw)
        assertTrue(a.online)
        assertEquals(user, a.profile!!.user)
        assertEquals(Server.norm(server), a.profile!!.server) // forme normalisée, clé incluse
        assertEquals(Server.norm(server), storeA.get("profile")!!.getString("server"))
        val js = a.items[jsId]!!
        assertEquals("Entrée JS", js.name)
        assertEquals("pw-js", js.password)
        assertEquals(listOf("example.org"), js.uris)
        assertEquals("PIN", js.fields[0].name)

        // Modification en conservant les champs inconnus
        a.save(listOf(Change.Put(js.copyData().put("password", "pw-modifié-par-kotlin"), jsId)))
        assertEquals("pw-modifié-par-kotlin", a.items[jsId]!!.password)
        assertEquals(42, a.items[jsId]!!.data.getJSONObject("inconnu").getInt("garde"))

        // Création
        val ktId = a.save(listOf(Change.Put(JSONObject()
            .put("type", "login").put("name", "Kotlin é ✓").put("username", "kt").put("password", "pw-kt")
            .put("uris", JSONArray(listOf("androidapp://app.test", "https://kt.example.com")))
            .put("totp", "JBSWY3DPEHPK3PXP").put("folder", "Tests"))))[0]
        val kt = a.items[ktId]!!
        assertTrue(kt.data.getLong("created") > 0)
        assertTrue(Domains.matchesApp(kt, "app.test"))

        // Appareil B : conflit 409 → resynchronisé
        val b = Vault(MemoryStore())
        b.login(server, user, pw)
        assertEquals("pw-kt", b.items[ktId]!!.password)
        a.save(listOf(Change.Put(a.items[ktId]!!.copyData().put("notes", "v2"), ktId)))
        expectStatus(409) { b.save(listOf(Change.Put(b.items[ktId]!!.copyData().put("notes", "conflit"), ktId))) }
        assertEquals("v2", b.items[ktId]!!.notes)

        // Suppression par B, vue par A
        val tmpId = b.save(listOf(Change.Put(JSONObject().put("name", "temp"))))[0]
        a.sync()
        assertTrue(a.items.containsKey(tmpId))
        b.save(listOf(Change.Delete(tmpId)))
        a.sync()
        assertFalse(a.items.containsKey(tmpId))
        assertEquals(a.cacheRev, b.cacheRev)

        // Mauvais mot de passe : 401 ; verrouillage / déverrouillage
        expectStatus(401) { b.unlock("faux") }
        a.lock()
        assertTrue(a.items.isEmpty())
        a.unlock(pw)
        assertTrue(a.online)
        assertEquals("v2", a.items[ktId]!!.notes)

        // Déverrouillage « empreinte » : clé brute + auth
        val raw = a.rawKey()!!
        val auth = a.auth!!
        a.lock()
        a.unlockWithKey(raw, auth)
        assertTrue(a.online)
        assertEquals("pw-kt", a.items[ktId]!!.password)
        expectStatus(401) { a.unlockWithKey(raw, Crypto.b64(ByteArray(32))) }

        // Session expirée (token invalide) : nouvelle session automatique avec l'auth, puis réessai
        a.api.token = "jeton-invalide"
        a.save(listOf(Change.Put(a.items[ktId]!!.copyData().put("notes", "v2"), ktId)))
        assertTrue(a.api.token != "jeton-invalide")
        a.api.token = "jeton-invalide"
        a.sync()
        assertTrue(a.online)

        // « Ne jamais verrouiller » : reprise sans réseau avec clé + auth conservées, connexion à la demande
        val keepStore = MemoryStore()
        keepStore.set("profile", storeA.get("profile")!!)
        keepStore.set("vault", storeA.get("vault")!!)
        val k = Vault(keepStore)
        k.load()
        k.resume(a.rawKey()!!, a.auth!!)
        assertFalse(k.online)
        assertEquals("pw-kt", k.items[ktId]!!.password)
        assertTrue(k.reconnect())
        assertTrue(k.online)
        // Mot de passe changé ailleurs (auth refusée) : le 401 remonte (l'app verrouille)
        val bad = Vault(keepStore)
        bad.load()
        bad.resume(a.rawKey()!!, Crypto.b64(ByteArray(32)))
        expectStatus(401) { bad.reconnect() }
        bad.api.token = "jeton-invalide"
        expectStatus(401) { bad.sync() }

        // Hors ligne : cache local seulement (serveur injoignable), lecture seule
        val offStore = MemoryStore()
        offStore.set("profile", storeA.get("profile")!!.put("server", "http://127.0.0.1:1"))
        offStore.set("vault", storeA.get("vault")!!)
        assertFalse(storeA.get("vault").toString().contains("pw-kt")) // aucun clair dans le cache
        assertFalse(storeA.get("profile").toString().contains("token"))
        val c = Vault(offStore)
        c.load()
        try {
            c.unlock("faux"); fail()
        } catch (e: BadPasswordException) { /* attendu */ }
        c.unlock(pw)
        assertFalse(c.online)
        assertEquals("pw-modifié-par-kotlin", c.items[jsId]!!.password)
        expectStatus(0) { c.save(listOf(Change.Delete(jsId))) }
        assertFalse(c.reconnect())
        c.lock()
        assertNull(c.rawKey())

        File(infoFile.path + ".kt").writeText(JSONObject().put("ktId", ktId).toString())
        println("Intégration OK : entrée Kotlin $ktId créée")
    }
}
