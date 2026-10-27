package app.biopass.core

import java.text.Normalizer
import java.util.Locale

/**
 * Détection des champs identifiant / mot de passe / code OTP d'un formulaire (saisie automatique).
 * Kotlin pur : l'adaptateur Android convertit les ViewNode en [FieldInfo], ce qui permet de tester
 * les heuristiques sur la JVM.
 */
class FieldInfo(
    val ref: Any?,
    val isText: Boolean,
    val visible: Boolean = true,
    val hints: List<String> = emptyList(),
    val inputType: Int = 0,
    val htmlTag: String? = null,
    val htmlAttrs: Map<String, String> = emptyMap(),
    val idEntry: String? = null,
    val hint: String? = null,
    val label: String? = null,
    val value: String? = null,
    val webDomain: String? = null,
)

enum class Kind { USERNAME, PASSWORD, OTP, OTHER }

class Form(val usernames: List<FieldInfo>, val passwords: List<FieldInfo>, val otps: List<FieldInfo>) {
    val isEmpty get() = usernames.isEmpty() && passwords.isEmpty() && otps.isEmpty()
    val all get() = usernames + passwords + otps
}

object FieldClassifier {
    // android.text.InputType (valeurs stables de l'API)
    private const val CLASS_MASK = 0x0f
    private const val CLASS_TEXT = 1
    private const val CLASS_NUMBER = 2
    private const val VAR_MASK = 0xff0
    private const val T_EMAIL = 0x20
    private const val T_PASSWORD = 0x80
    private const val T_VISIBLE_PASSWORD = 0x90
    private const val T_WEB_EMAIL = 0xd0
    private const val T_WEB_PASSWORD = 0xe0
    private const val T_FILTER = 0xb0
    private const val N_PASSWORD = 0x10

    private val SKIP_TYPES = setOf("hidden", "submit", "button", "checkbox", "radio", "image", "reset", "file", "search",
        "color", "date", "datetime-local", "month", "week", "time", "range", "number")
    private val USER_WORDS = listOf("user", "login", "email", "e-mail", "mail", "identifiant", "ident", "pseudo", "account",
        "compte", "utilisateur", "courriel", "username", "userid", "nom d'utilisateur", "adresse e-mail")
    private val PASS_WORDS = listOf("password", "passwd", "pwd", "pass", "mot de passe", "motdepasse", "mot_de_passe",
        "mot-de-passe", "mdp", "passcode", "passwort", "contrasena")
    private val OTP_WORDS = listOf("otp", "2fa", "totp", "mfa", "one-time", "onetime", "one_time", "verification", "verif",
        "authenticat", "authentification", "security code", "code de securite", "code de verification", "sms code", "code")
    private val OTP_EXCLUDE = listOf("postal", "zip", "promo", "coupon", "pays", "country", "cvv", "cvc", "card", "carte",
        "gift", "cadeau", "parrain", "referral", "invit", "area", "reduction", "discount", "voucher", "naf", "ape", "iban", "bic", "swift")
    private val SEARCH_WORDS = listOf("search", "recherche", "rechercher", "query", "find")
    // Indices autofill explicites qui ne concernent pas un identifiant (adresse, carte, nom…)
    private val OTHER_HINTS = listOf("postal", "address", "creditcard", "cc-", "name", "phone", "tel", "birth", "gender",
        "country", "city", "street", "zip")

    private fun norm(s: String) = Normalizer.normalize(s.lowercase(Locale.ROOT), Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "")

    private fun has(words: String, list: List<String>) = list.any { words.contains(it) }

    fun classify(f: FieldInfo): Kind? {
        if (f.ref == null || !f.visible) return null
        val tag = f.htmlTag?.lowercase(Locale.ROOT)
        val type = f.htmlAttrs["type"]?.lowercase(Locale.ROOT)?.trim() ?: ""
        if (tag != null && tag != "input") return null
        if (tag == null && !f.isText) return null
        if (type in SKIP_TYPES) return null

        // 1. Indices explicites (autofillHints / autocomplete)
        val hints = norm(f.hints.joinToString(" "))
        val ac = norm(f.htmlAttrs["autocomplete"] ?: "")
        val explicit = "$hints $ac"
        if (explicit.isNotBlank()) {
            if (has(explicit, listOf("one-time-code", "otp", "2fa"))) return Kind.OTP
            if (explicit.contains("password")) return Kind.PASSWORD
            if (has(explicit, listOf("username", "email", "login"))) return Kind.USERNAME
            if (hints.isNotBlank() && has(hints, OTHER_HINTS)) return Kind.OTHER
            if (ac.isNotBlank() && ac !in setOf("on", "off") && has(ac, OTHER_HINTS)) return Kind.OTHER
        }
        if (type == "password") return Kind.PASSWORD

        val cls = f.inputType and CLASS_MASK
        val variation = f.inputType and VAR_MASK
        val words = norm(listOfNotNull(f.idEntry, f.hint, f.label, f.htmlAttrs["name"], f.htmlAttrs["id"],
            f.htmlAttrs["placeholder"], f.htmlAttrs["aria-label"], f.htmlAttrs["label"]).joinToString(" "))
        if (has(words, SEARCH_WORDS) || cls == CLASS_TEXT && variation == T_FILTER) return null

        val otpWords = has(words, OTP_WORDS) && !has(words, OTP_EXCLUDE) && !has(words, PASS_WORDS + USER_WORDS)
        if (cls == CLASS_NUMBER && variation == N_PASSWORD) return if (otpWords) Kind.OTP else Kind.PASSWORD
        if (cls == CLASS_TEXT && (variation == T_PASSWORD || variation == T_WEB_PASSWORD)) return Kind.PASSWORD
        if (otpWords) return Kind.OTP
        if (cls == CLASS_TEXT && variation == T_VISIBLE_PASSWORD) return if (has(words, USER_WORDS) && !has(words, PASS_WORDS)) Kind.USERNAME else Kind.PASSWORD
        if (has(words, PASS_WORDS)) return Kind.PASSWORD
        if (type == "email" || cls == CLASS_TEXT && (variation == T_EMAIL || variation == T_WEB_EMAIL)) return Kind.USERNAME
        if (has(words, USER_WORDS)) return Kind.USERNAME
        if (type == "tel") return Kind.OTHER
        return Kind.OTHER
    }

    /**
     * Analyse les champs (dans l'ordre de parcours). Si un mot de passe est trouvé sans
     * identifiant, le dernier champ texte « ordinaire » qui le précède sert d'identifiant.
     */
    fun analyze(fields: List<FieldInfo>): Form {
        val users = ArrayList<FieldInfo>()
        val pws = ArrayList<FieldInfo>()
        val otps = ArrayList<FieldInfo>()
        var lastOther: FieldInfo? = null
        var fallback: FieldInfo? = null
        for (f in fields) {
            when (classify(f)) {
                Kind.USERNAME -> users.add(f)
                Kind.PASSWORD -> {
                    if (pws.isEmpty()) fallback = lastOther
                    pws.add(f)
                }
                Kind.OTP -> otps.add(f)
                Kind.OTHER -> if (f.htmlAttrs["type"]?.lowercase(Locale.ROOT) != "tel") lastOther = f
                null -> {}
            }
        }
        if (users.isEmpty() && pws.isNotEmpty()) fallback?.let { users.add(it) }
        return Form(users, pws, otps)
    }
}

private fun short(s: String, n: Int) = if (s.length <= n) s else s.take(n - 1).trimEnd() + "…"

/**
 * Texte des suggestions du clavier : l'identifiant (repli : le nom), tronqué ; si deux
 * suggestions auraient le même texte, le nom est ajouté en suffixe court (« lisa · Apple »).
 */
fun chipLabels(items: List<Item>): List<String> {
    val base = items.map { short(it.username.trim().ifBlank { it.name.trim() }.ifBlank { "(sans nom)" }, 24) }
    val counts = base.groupingBy { it }.eachCount()
    return items.mapIndexed { i, it ->
        if ((counts[base[i]] ?: 0) > 1 && it.username.isNotBlank() && it.name.isNotBlank()) base[i] + " · " + short(it.name.trim(), 14)
        else base[i]
    }
}

/**
 * Couleur stable d'une entrée (pastille des suggestions) : FNV-1a 32 bits de fold(identifiant)
 * en UTF-8 (repli : le nom), modulo une palette fixe de couleurs distinctes, lisibles en clair et sombre.
 */
object Palette {
    val COLORS = intArrayOf(
        0xFFE53935.toInt(), // rouge
        0xFFFB8C00.toInt(), // orange
        0xFFF2B600.toInt(), // jaune
        0xFF7CB342.toInt(), // vert clair
        0xFF2E9E4F.toInt(), // vert
        0xFF00A39A.toInt(), // turquoise
        0xFF039BE5.toInt(), // bleu ciel
        0xFF3D6FE0.toInt(), // bleu
        0xFF6D5BD0.toInt(), // indigo
        0xFFA94BC9.toInt(), // violet
        0xFFE0457B.toInt(), // rose
        0xFF8D6E63.toInt(), // brun
    )

    fun fnv1a(s: String): Int {
        var h = 0x811c9dc5.toInt()
        for (b in s.toByteArray(Charsets.UTF_8)) {
            h = h xor (b.toInt() and 0xff)
            h *= 0x01000193
        }
        return h
    }

    fun index(item: Item): Int {
        val key = Search.fold(item.username.trim().ifBlank { item.name.trim() })
        return ((fnv1a(key).toLong() and 0xffffffffL) % COLORS.size).toInt()
    }

    fun color(item: Item) = COLORS[index(item)]
}

/**
 * Catégorie d'une entrée sans icône de site (comme `entryKind` de core.js) :
 * network, terminal, wifi, card, key, app, note, ou null (initiale).
 */
object Kinds {
    // \b de JavaScript (mots ASCII [A-Za-z0-9_]) : lookarounds explicites, identiques sur JVM et Android
    private fun js(re: String) = Regex(re.replace("\\b", "(?:(?<![A-Za-z0-9_])(?=[A-Za-z0-9_])|(?<=[A-Za-z0-9_])(?![A-Za-z0-9_]))"))

    // [0-9] et non \d : sur Android (ICU), \d accepte aussi les chiffres non ASCII
    private val IPV4 = Regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$")
    private val LOCAL = Regex("\\.(local|lan|home|internal|localdomain)$")
    private val SSH_URI = Regex("^ssh:", RegexOption.IGNORE_CASE)
    private val TERMINAL = js("\\bssh\\b|\\bsftp\\b|serveur|\\bvps\\b")
    private val WIFI = js("wi-?fi|\\bssid\\b|\\bwlan\\b|\\bbox\\b")
    private val CARD = js("\\b(carte|visa|mastercard|amex|cb)\\b")
    private val NUMERO = Regex("numero")
    private val CODE = Regex("(code|cvv|cvc|exp)")
    private val KEY = js("\\b(api|token|jeton|cle|key|licen[cs]e|ssh-key)\\b")
    private val APP_URI = Regex("^androidapp:", RegexOption.IGNORE_CASE)

    fun of(it: Item): String? {
        val uris = it.uris
        val hosts = uris.map { u -> Domains.hostOf(u) }
        val text = Search.fold("${it.name} ${it.folder}")
        // IPv4, IPv6 (entre crochets dans une URL), localhost ou nom de réseau local
        if (hosts.any { h -> IPV4.containsMatchIn(h) || h.startsWith("[") || h == "localhost" || LOCAL.containsMatchIn(h) }) return "network"
        if (uris.any { u -> SSH_URI.containsMatchIn(u) } || TERMINAL.containsMatchIn(text)) return "terminal"
        if (WIFI.containsMatchIn(text)) return "wifi"
        val fieldNames = Search.fold(it.fields.joinToString(" ") { f -> f.name })
        if (CARD.containsMatchIn(text) || (NUMERO.containsMatchIn(fieldNames) && CODE.containsMatchIn(fieldNames))) return "card"
        if (KEY.containsMatchIn(text)) return "key"
        if (uris.isNotEmpty() && uris.all { u -> APP_URI.containsMatchIn(u) }) return "app"
        if (it.data.optString("type") == "note" || uris.isEmpty()) return "note"
        return null
    }

    /** Dégradés des tuiles (KIND_COLORS du site, 135°). */
    val COLORS = mapOf(
        "network" to intArrayOf(0xFF0EA5E9.toInt(), 0xFF0369A1.toInt()),
        "terminal" to intArrayOf(0xFF475569.toInt(), 0xFF0F172A.toInt()),
        "wifi" to intArrayOf(0xFF22C55E.toInt(), 0xFF0F766E.toInt()),
        "card" to intArrayOf(0xFFF59E0B.toInt(), 0xFFB45309.toInt()),
        "key" to intArrayOf(0xFFA855F7.toInt(), 0xFF6D28D9.toInt()),
        "app" to intArrayOf(0xFF10B981.toInt(), 0xFF047857.toInt()),
        "note" to intArrayOf(0xFFFACC15.toInt(), 0xFFCA8A04.toInt()),
    )
}
