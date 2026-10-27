package app.biopass.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

// ------------------------------------------------------------------ entrée

/** Entrée déchiffrée. [data] est le JSON complet (champs inconnus conservés). */
class Item(val id: String, val rev: Long, val data: JSONObject) {
    private fun s(k: String): String = if (data.has(k) && !data.isNull(k)) data.opt(k)?.toString() ?: "" else ""
    val type get() = s("type").ifEmpty { "login" }
    val name get() = s("name")
    val username get() = s("username")
    val password get() = s("password")
    val totp get() = s("totp")
    val notes get() = s("notes")
    val folder get() = s("folder")
    val fav get() = data.optBoolean("fav", false)
    val uris: List<String>
        get() = (data.optJSONArray("uris") ?: JSONArray()).let { a ->
            (0 until a.length()).mapNotNull { a.opt(it)?.takeIf { v -> v != JSONObject.NULL }?.toString() }
        }

    class Field(val name: String, val value: String, val hidden: Boolean)

    val fields: List<Field>
        get() = (data.optJSONArray("fields") ?: JSONArray()).let { a ->
            (0 until a.length()).mapNotNull { i ->
                a.optJSONObject(i)?.let {
                    Field(it.optString("name", ""), if (it.isNull("value")) "" else it.opt("value")?.toString() ?: "", it.optBoolean("hidden", false))
                }
            }
        }

    class Old(val password: String, val date: Long)

    /** Anciens mots de passe (le plus récent d'abord). */
    val history: List<Old>
        get() = (data.optJSONArray("history") ?: JSONArray()).let { a ->
            (0 until a.length()).mapNotNull { i ->
                a.optJSONObject(i)?.let { Old(if (it.isNull("password")) "" else it.optString("password"), it.optLong("date", 0)) }
            }.filter { it.password.isNotEmpty() }
        }

    /** « dark » : logo très sombre sur fond transparent ; « light » : très clair ; "" sinon. */
    val iconTone get() = s("iconTone")

    /** Icône du site (data URL PNG récupérée par le site web / l'extension), ou null. */
    val icon: String? get() = s("icon").takeIf { it.startsWith("data:image/") && it.contains("base64,") }

    /** Octets de l'icône (PNG), ou null si absente / invalide. */
    fun iconBytes(): ByteArray? = icon?.let {
        try {
            java.util.Base64.getDecoder().decode(it.substringAfter("base64,").trim())
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    /** Catégorie (network, terminal, wifi, card, key, app, note) ou null — voir [Kinds]. */
    val kind: String? by lazy { Kinds.of(this) }

    /** Champs « pliés » de la recherche approximative, calculés une fois. */
    val fz: Search.Fields by lazy { Search.fields(this) }

    /** Copie modifiable du JSON (pour l'édition). */
    fun copyData() = JSONObject(data.toString())
}

/**
 * Comme `withHistory` de core.js : si le mot de passe change, l'ancien est poussé en tête de
 * `history` (10 au plus). Modifie et renvoie [next].
 */
fun withHistory(prev: Item?, next: JSONObject, now: Long = System.currentTimeMillis()): JSONObject {
    val old = prev?.password ?: ""
    val new = if (next.isNull("password")) "" else next.optString("password", "")
    if (old.isEmpty() || old == new) return next
    val h = JSONArray().put(JSONObject().put("password", old).put("date", now))
    val prevH = prev!!.data.optJSONArray("history") ?: JSONArray()
    for (i in 0 until prevH.length()) if (h.length() < 10) h.put(prevH.get(i))
    return next.put("history", h)
}

/**
 * Après modification des adresses d'une entrée : si la liste d'URI a changé, l'icône ne correspond
 * plus forcément au site ; on retire `icon`, `iconTry`, `iconTone`, `iconV` (le site / l'extension la récupéreront).
 */
fun dropIconIfUrisChanged(before: List<String>, data: JSONObject): JSONObject {
    val after = data.optJSONArray("uris")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
    if (after.map { it.trim() } != before.map { it.trim() }) {
        for (k in listOf("icon", "iconTry", "iconTone", "iconV")) data.remove(k)
    }
    return data
}

// ------------------------------------------------------------------ API

class ApiError(val status: Int, message: String, val data: JSONObject = JSONObject()) : Exception(message)

/**
 * Adresse du serveur telle que saisie (ex. « https://example.com/biopass/?k=GUID ») — comme
 * `parseServer` / `normServer` / `webUrl` de core.js. La clé d'accès `k` est envoyée dans
 * l'en-tête X-BP-Key ; elle ne doit jamais être affichée.
 */
object Server {
    class Parsed(val base: String, val key: String)

    fun parse(input: String?): Parsed {
        var s = (input ?: "").trim()
        if (s.isEmpty() || s == ".") return Parsed(".", "")
        if (!Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(s)) s = "https://$s"
        val u = try {
            java.net.URI(s)
        } catch (e: Exception) {
            throw IllegalArgumentException("Adresse du serveur invalide")
        }
        val scheme = (u.scheme ?: "https").lowercase()
        val host = u.host?.lowercase() ?: throw IllegalArgumentException("Adresse du serveur invalide")
        val port = if (u.port == -1 || (scheme == "https" && u.port == 443) || (scheme == "http" && u.port == 80)) "" else ":${u.port}"
        val path = (u.rawPath ?: "").replace(Regex("/(index\\.html|index\\.php|api\\.php)$"), "").replace(Regex("/+$"), "")
        var key = ""
        for (kv in (u.rawQuery ?: "").split('&')) {
            val k = java.net.URLDecoder.decode(kv.substringBefore('='), "UTF-8")
            if (k == "k") {
                key = java.net.URLDecoder.decode(kv.substringAfter('=', ""), "UTF-8")
                break
            }
        }
        return Parsed("$scheme://$host$port$path", key)
    }

    /** Forme normalisée à stocker (clé incluse). */
    fun norm(input: String?): String = parse(input).let { it.base + if (it.key.isNotEmpty()) "/?k=" + encodeURIComponent(it.key) else "" }

    /** URL de l'app web correspondante. */
    fun webUrl(server: String?): String = parse(server).let { it.base + "/" + if (it.key.isNotEmpty()) "?k=" + encodeURIComponent(it.key) else "" }

    /** Adresse affichable (sans la clé). */
    fun display(server: String?): String = try { parse(server).base } catch (e: Exception) { "" }

    fun encodeURIComponent(s: String): String {
        val keep = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
        val sb = StringBuilder()
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val c = (b.toInt() and 0xff)
            if (c < 128 && keep.indexOf(c.toChar()) >= 0) sb.append(c.toChar()) else sb.append('%').append("%02X".format(c))
        }
        return sb.toString()
    }
}

class Api(server: String) {
    val base: String
    /** Clé d'accès optionnelle (en-tête X-BP-Key). */
    val key: String
    @Volatile var token: String? = null

    init {
        val p = try { Server.parse(server) } catch (e: IllegalArgumentException) { Server.Parsed("", "") }
        base = p.base
        key = p.key
    }

    fun call(action: String, body: JSONObject?, query: String = ""): JSONObject {
        val conn: HttpURLConnection
        val code: Int
        val text: String
        try {
            conn = URL("$base/api.php?a=$action$query").openConnection() as HttpURLConnection
            conn.connectTimeout = 10_000
            conn.readTimeout = 30_000
            conn.useCaches = false
            conn.instanceFollowRedirects = false
            conn.setRequestProperty("Accept", "application/json")
            if (key.isNotEmpty()) conn.setRequestProperty("X-BP-Key", key)
            token?.let { conn.setRequestProperty("X-BP-Token", it) }
            if (body != null) {
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                val bytes = body.toString().toByteArray(Charsets.UTF_8)
                conn.setFixedLengthStreamingMode(bytes.size)
                conn.outputStream.use { it.write(bytes) }
            }
            code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            conn.disconnect()
        } catch (e: IOException) {
            throw ApiError(0, "Serveur injoignable")
        } catch (e: IllegalArgumentException) {
            throw ApiError(0, "Adresse du serveur invalide")
        }
        val data = try {
            JSONObject(text)
        } catch (e: Exception) {
            JSONObject()
        }
        if (code !in 200..299) {
            val msg = if (data.has("error")) data.optString("error") else "Erreur serveur ($code)"
            throw ApiError(code, msg, data)
        }
        return data
    }

    fun prelogin(user: String) = call("prelogin", JSONObject().put("user", user))
    fun login(user: String, auth: String) = call("login", JSONObject().put("user", user).put("auth", auth))
    fun register(body: JSONObject) = call("register", body)
    fun sync(since: Long) = call("sync", null, "&since=$since")
    fun save(changes: JSONArray) = call("save", JSONObject().put("changes", changes))
}

// ------------------------------------------------------------------ stockage

/** Stockage clé → JSON. Clés : "profile" = {server,user,salt,iter,wrapped}, "vault" = {rev, items:{id:{rev,enc}}}. */
interface Store {
    fun get(key: String): JSONObject?
    fun set(key: String, value: JSONObject)
    fun remove(key: String)
}

class MemoryStore : Store {
    private val m = HashMap<String, String>()
    @Synchronized override fun get(key: String) = m[key]?.let { JSONObject(it) }
    @Synchronized override fun set(key: String, value: JSONObject) { m[key] = value.toString() }
    @Synchronized override fun remove(key: String) { m.remove(key) }
}

class Profile(val server: String, val user: String, val salt: String, val iter: Int, val wrapped: String) {
    fun toJson(): JSONObject = JSONObject().put("server", server).put("user", user).put("salt", salt).put("iter", iter).put("wrapped", wrapped)

    companion object {
        fun from(o: JSONObject) = Profile(o.getString("server"), o.getString("user"), o.getString("salt"), o.getInt("iter"), o.getString("wrapped"))
    }
}

class CachedItem(val rev: Long, val enc: String)

// ------------------------------------------------------------------ coffre

sealed class Change {
    /** Création (id = null) ou modification d'une entrée. */
    class Put(val data: JSONObject, val id: String? = null) : Change()
    class Delete(val id: String) : Change()
}

/**
 * Coffre BioPass : même flux que la classe `Vault` de core.js.
 * Les opérations réseau sont bloquantes (à appeler hors du thread UI, une à la fois).
 * [items] est remplacée atomiquement : lisible depuis n'importe quel thread.
 */
class Vault(private val store: Store) {
    var profile: Profile? = null
        private set
    private var rev = 0L
    private var cacheItems = LinkedHashMap<String, CachedItem>()

    @Volatile private var key: ByteArray? = null
    /** auth (b64) du mot de passe courant : permet de se reconnecter et d'activer l'empreinte. */
    @Volatile var auth: String? = null
        private set
    @Volatile var items: Map<String, Item> = emptyMap()
        private set
    @Volatile var online = false
        private set
    var api = Api("")
        private set

    val unlocked get() = key != null
    val cacheRev get() = rev

    /** Copie de la clé brute du coffre (pour l'empreinte). */
    fun rawKey(): ByteArray? = key?.copyOf()

    fun load(): Profile? {
        profile = store.get("profile")?.let { runCatching { Profile.from(it) }.getOrNull() }
        loadCache(store.get("vault"))
        profile?.let { api = Api(it.server) }
        return profile
    }

    private fun loadCache(o: JSONObject?) {
        rev = o?.optLong("rev", 0) ?: 0
        cacheItems = LinkedHashMap()
        o?.optJSONObject("items")?.let { its ->
            for (id in its.keys()) {
                val it = its.getJSONObject(id)
                cacheItems[id] = CachedItem(it.optLong("rev"), it.getString("enc"))
            }
        }
    }

    private fun saveCache() {
        val its = JSONObject()
        for ((id, it) in cacheItems) its.put(id, JSONObject().put("rev", it.rev).put("enc", it.enc))
        store.set("vault", JSONObject().put("rev", rev).put("items", its))
    }

    private fun open(raw: ByteArray, token: String?, online: Boolean, auth: String) {
        key = raw
        this.auth = auth
        api.token = token
        this.online = online
        decryptAll()
        if (online) sync()
    }

    /** Première connexion sur cet appareil (ou changement d'utilisateur). */
    fun login(server: String, user: String, password: String) {
        val u = user.trim().lowercase()
        val a = Api(server)
        val pre = a.prelogin(u)
        val k = Crypto.deriveKeys(password, pre.getString("salt"), pre.getInt("iter"))
        val r = a.login(u, k.auth)
        val raw = Crypto.unwrapVaultKey(k.wrapKey, r.getString("wrapped"))
        newProfile(Server.norm(server), r)
        api = a
        open(raw, r.getString("token"), true, k.auth)
    }

    private fun newProfile(server: String, r: JSONObject) {
        val same = profile?.let { it.server == server && it.user == r.getString("user") } == true
        profile = Profile(server, r.getString("user"), r.getString("salt"), r.getInt("iter"), r.getString("wrapped"))
        store.set("profile", profile!!.toJson())
        if (!same) {
            rev = 0
            cacheItems = LinkedHashMap()
            saveCache()
        }
    }

    /**
     * Déverrouillage : en ligne si possible (rafraîchit le profil), sinon depuis le cache.
     * [progress] est appelé avant la dérivation de clé (étape lente).
     */
    fun unlock(password: String) {
        val p = profile ?: throw IllegalStateException("Aucun compte configuré")
        try {
            val pre = api.prelogin(p.user)
            val k = Crypto.deriveKeys(password, pre.getString("salt"), pre.getInt("iter"))
            val r = api.login(p.user, k.auth)
            val raw = Crypto.unwrapVaultKey(k.wrapKey, r.getString("wrapped"))
            newProfile(p.server, r)
            open(raw, r.getString("token"), true, k.auth)
            return
        } catch (e: ApiError) {
            if (e.status != 0) throw e
        }
        val k = Crypto.deriveKeys(password, p.salt, p.iter)
        open(Crypto.unwrapVaultKey(k.wrapKey, p.wrapped), null, false, k.auth)
    }

    /**
     * Déverrouillage avec la clé brute et l'auth conservées (empreinte) : connexion avec [auth]
     * si le serveur répond, sinon cache hors ligne. 401 = mot de passe changé ailleurs.
     */
    fun unlockWithKey(raw: ByteArray, auth: String) {
        val p = profile ?: throw IllegalStateException("Aucun compte configuré")
        try {
            val r = api.login(p.user, auth)
            newProfile(p.server, r)
            open(raw, r.getString("token"), true, auth)
            return
        } catch (e: ApiError) {
            if (e.status != 0) throw e
        }
        open(raw, null, false, auth)
    }

    /**
     * Reprise sans réseau avec la clé et l'auth conservées (option « ne jamais verrouiller ») :
     * déchiffre le cache ; la connexion se fera à la demande ([reconnect] ou 401 → nouvelle session).
     */
    fun resume(raw: ByteArray, auth: String) {
        if (profile == null) throw IllegalStateException("Aucun compte configuré")
        open(raw, null, false, auth)
    }

    /**
     * Exécute [block] ; sur 401 (session expirée), rouvre une session avec l'auth en mémoire puis
     * réessaie une fois. Si cette connexion échoue en 401, le mot de passe a changé : l'erreur remonte.
     */
    private fun <T> withRelogin(block: () -> T): T = try {
        block()
    } catch (e: ApiError) {
        val p = profile
        val a = auth
        if (e.status != 401 || p == null || a == null || key == null) throw e
        val r = api.login(p.user, a)
        newProfile(p.server, r)
        api.token = r.getString("token")
        online = true
        block()
    }

    /** Hors ligne mais déverrouillé : retente une connexion (nouveau token) avec l'auth en mémoire. */
    fun reconnect(): Boolean {
        val p = profile ?: return false
        val a = auth ?: return false
        if (key == null) return false
        if (api.token != null) return true
        val r = try {
            api.login(p.user, a)
        } catch (e: ApiError) {
            if (e.status == 0) return false
            throw e
        }
        newProfile(p.server, r)
        api.token = r.getString("token")
        online = true
        sync()
        return true
    }

    fun lock() {
        key?.fill(0)
        key = null
        auth = null
        items = emptyMap()
        api.token = null
    }

    fun forget() {
        lock()
        store.remove("profile")
        store.remove("vault")
        profile = null
        rev = 0
        cacheItems = LinkedHashMap()
        online = false
        api = Api("")
    }

    private fun decrypt(k: ByteArray, id: String, it: CachedItem): Item? = try {
        // champs de recherche calculés ici (thread de fond) et non à la première frappe
        Item(id, it.rev, JSONObject(Crypto.decryptItem(k, id, it.enc))).also { i -> i.fz }
    } catch (e: Exception) {
        null // entrée indéchiffrable : ignorée (comme core.js)
    }

    private fun decryptAll() {
        val k = key ?: return
        val m = HashMap<String, Item>()
        for ((id, it) in cacheItems) decrypt(k, id, it)?.let { m[id] = it }
        if (key === k) items = m
    }

    /** Récupère les changements du serveur. Retourne true si quelque chose a changé. */
    fun sync(): Boolean {
        if (api.token == null) return false
        val r = try {
            withRelogin { api.sync(rev) }
        } catch (e: ApiError) {
            if (e.status == 0) {
                online = false
                return false
            }
            throw e
        }
        online = true
        val full = r.optBoolean("full", false)
        val newRev = r.getLong("rev")
        if (!full && newRev == rev) return false
        val k = key
        val m = if (full) HashMap() else HashMap(items)
        if (full) cacheItems = LinkedHashMap()
        val arr = r.getJSONArray("items")
        for (i in 0 until arr.length()) {
            val it = arr.getJSONObject(i)
            val id = it.getString("id")
            if (it.optBoolean("del", false)) {
                cacheItems.remove(id)
                m.remove(id)
            } else {
                val c = CachedItem(it.getLong("rev"), it.getString("enc"))
                cacheItems[id] = c
                if (k != null) decrypt(k, id, c)?.let { d -> m[id] = d }
            }
        }
        rev = newRev
        if (k != null && key === k) items = m
        saveCache()
        return true
    }

    /** Enregistre des changements (atomique côté serveur), puis resynchronise. Retourne les ids. */
    fun save(changes: List<Change>): List<String> {
        if (api.token == null) throw ApiError(0, "Hors ligne : modification impossible")
        val k = key ?: throw IllegalStateException("Coffre verrouillé")
        val now = System.currentTimeMillis()
        val out = JSONArray()
        val ids = ArrayList<String>()
        for (c in changes) {
            when (c) {
                is Change.Delete -> {
                    out.put(JSONObject().put("id", c.id).put("prev", cacheItems[c.id]?.rev ?: 0).put("del", true))
                    ids.add(c.id)
                }
                is Change.Put -> {
                    val obj = JSONObject(c.data.toString())
                    obj.keys().asSequence().filter { it.startsWith("_") }.toList().forEach { obj.remove(it) }
                    val id = c.id ?: Crypto.newId()
                    if (!obj.has("created") || obj.isNull("created")) obj.put("created", now)
                    obj.put("updated", now)
                    val prev = if (c.id != null) cacheItems[c.id]?.rev ?: 0 else 0
                    out.put(JSONObject().put("id", id).put("prev", prev).put("enc", Crypto.encryptItem(k, id, obj.toString())))
                    ids.add(id)
                }
            }
        }
        try {
            withRelogin { api.save(out) }
        } finally {
            sync()
        }
        return ids
    }

    fun list(): List<Item> = items.values.toList()
}
