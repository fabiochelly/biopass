package app.biopass.core

import java.net.URLDecoder
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.text.Normalizer
import java.util.Locale

// ------------------------------------------------------------------ domaines (cf. core.js)

object Domains {
    private val MULTI = setOf(
        "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp",
        "com.br", "com.mx", "co.za", "com.tr", "co.in", "com.cn", "com.hk", "com.sg", "co.kr", "com.ar", "gouv.fr", "asso.fr", "co.il",
    )
    private val SCHEME = Regex("^[a-z][a-z0-9+.-]*:", RegexOption.IGNORE_CASE)

    /** Nom d'hôte d'une URI (équivalent de `new URL(uri).hostname`) ; "" si aucun. */
    fun hostOf(uri: String?): String {
        if (uri.isNullOrBlank()) return ""
        val u = uri.trim().let { if (SCHEME.containsMatchIn(it)) it else "https://$it" }
        val i = u.indexOf(':')
        if (!u.startsWith("//", i + 1)) return ""
        var auth = u.substring(i + 3)
        auth = auth.substring(0, auth.indexOfAny(charArrayOf('/', '?', '#', '\\')).let { if (it < 0) auth.length else it })
        auth = auth.substringAfterLast('@')
        val host = if (auth.startsWith("[")) {
            auth.substring(0, auth.indexOf(']').let { if (it < 0) return "" else it + 1 })
        } else {
            auth.substringBefore(':')
        }
        if (host.any { it.isWhitespace() || it == '<' || it == '>' }) return ""
        return host.lowercase(Locale.ROOT)
    }

    fun baseDomain(host: String?): String {
        val h = (host ?: "").lowercase(Locale.ROOT).removeSuffix(".")
        if (h.all { it.isDigit() || it == '.' } || h.contains(':') || h.startsWith("[")) return h
        val p = h.split('.')
        if (p.size <= 2) return h
        val last2 = p.takeLast(2).joinToString(".")
        return if (last2 in MULTI) p.takeLast(3).joinToString(".") else last2
    }

    fun matchesUrl(item: Item, pageUrl: String): Boolean {
        val d = baseDomain(hostOf(pageUrl))
        return d.isNotEmpty() && item.uris.any { baseDomain(hostOf(it)) == d }
    }

    /** Correspondance pour la saisie automatique : domaine web (hors androidapp://) ou paquet d'app. */
    fun matchesWebDomain(item: Item, webDomain: String): Boolean {
        val d = baseDomain(webDomain)
        return d.isNotEmpty() && item.uris.any { !isAppUri(it) && baseDomain(hostOf(it)) == d }
    }

    fun appUri(pkg: String) = "androidapp://$pkg"
    fun isAppUri(u: String) = u.trim().lowercase(Locale.ROOT).startsWith("androidapp://")
    fun matchesApp(item: Item, pkg: String): Boolean {
        val want = appUri(pkg).lowercase(Locale.ROOT)
        return item.uris.any { it.trim().trimEnd('/').lowercase(Locale.ROOT) == want }
    }
}

// ------------------------------------------------------------------ TOTP

object Totp {
    class Params(val secret: String, val digits: Int, val period: Int, val algo: String)
    class Code(val code: String, val remaining: Int, val period: Int)

    private fun leadingInt(s: String?): Int = s?.trim()?.takeWhile { it.isDigit() }?.toIntOrNull() ?: 0

    fun parse(str: String?): Params {
        val s = (str ?: "").trim()
        if (!s.lowercase(Locale.ROOT).startsWith("otpauth://")) return Params(s, 6, 30, "HmacSHA1")
        val q = mutableMapOf<String, String>()
        s.substringAfter('?', "").substringBefore('#').split('&').forEach { kv ->
            if (kv.isEmpty()) return@forEach
            val k = URLDecoder.decode(kv.substringBefore('='), "UTF-8")
            if (k !in q) q[k] = URLDecoder.decode(kv.substringAfter('=', ""), "UTF-8")
        }
        val algo = when ((q["algorithm"] ?: "").uppercase(Locale.ROOT)) {
            "SHA256" -> "HmacSHA256"
            "SHA512" -> "HmacSHA512"
            else -> "HmacSHA1"
        }
        return Params(q["secret"] ?: "", leadingInt(q["digits"]).takeIf { it > 0 } ?: 6,
            leadingInt(q["period"]).takeIf { it > 0 } ?: 30, algo)
    }

    fun base32(input: String): ByteArray {
        val alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        val s = input.uppercase(Locale.ROOT).filter { !it.isWhitespace() && it != '=' && it != '-' }
        val out = java.io.ByteArrayOutputStream()
        var bits = 0
        var v = 0
        for (c in s) {
            val i = alpha.indexOf(c)
            require(i >= 0) { "Secret TOTP invalide" }
            v = (v shl 5) or i
            bits += 5
            if (bits >= 8) {
                out.write((v ushr (bits - 8)) and 255)
                bits -= 8
            }
        }
        return out.toByteArray()
    }

    fun code(str: String?, nowMs: Long = System.currentTimeMillis()): Code {
        val p = parse(str)
        val counter = Math.floorDiv(nowMs / 1000, p.period.toLong())
        val h = Crypto.hmac(base32(p.secret), ByteBuffer.allocate(8).putLong(counter).array(), p.algo)
        val o = h[h.size - 1].toInt() and 15
        val bin = ((h[o].toInt() and 127) shl 24) or ((h[o + 1].toInt() and 255) shl 16) or
            ((h[o + 2].toInt() and 255) shl 8) or (h[o + 3].toInt() and 255)
        var mod = 1L
        repeat(p.digits) { mod *= 10 }
        val code = (bin.toLong() % mod).toString().padStart(p.digits, '0')
        return Code(code, p.period - ((nowMs / 1000) % p.period).toInt(), p.period)
    }

    /** Code ou null si le secret est vide/invalide. */
    fun codeOrNull(str: String?): Code? = if (str.isNullOrBlank()) null else try {
        code(str)
    } catch (e: Exception) {
        null
    }
}

// ------------------------------------------------------------------ générateur

object PasswordGen {
    private const val LOWER = "abcdefghijkmnopqrstuvwxyz"
    private const val UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"
    private const val DIGITS = "23456789"
    private const val SYMBOLS = "!@#\$%&*-_=+?.:;"
    private val rng = SecureRandom()

    fun generate(length: Int = 20, lower: Boolean = true, upper: Boolean = true, digits: Boolean = true, symbols: Boolean = true): String {
        val sets = listOfNotNull(LOWER.takeIf { lower }, UPPER.takeIf { upper }, DIGITS.takeIf { digits }, SYMBOLS.takeIf { symbols })
            .ifEmpty { listOf(LOWER) }
        val all = sets.joinToString("")
        while (true) {
            val pw = String(CharArray(length) { all[rng.nextInt(all.length)] })
            if (length < sets.size || sets.all { s -> pw.any { it in s } }) return pw
        }
    }
}

// ------------------------------------------------------------------ recherche approximative
// Spécification commune à tous les clients : PROTOCOL.md § 5, référence `search` de core.js,
// vecteurs tools/search-vectors.json. À reproduire à l'identique (ordre compris).

object Search {
    private val DIACRITICS = Regex("[\u0300-\u036f]")
    // \s de JavaScript (ASCII + espaces Unicode)
    private val SPACES = Regex("[\\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")
    private val SEP = Regex("[^a-z0-9]+")
    private val WWW = Regex("^www\\.")

    /** Minuscules, sans accents, « œ/æ » développés. */
    fun fold(str: String?): String =
        Normalizer.normalize((str ?: "").lowercase(Locale.ROOT).replace("œ", "oe").replace("æ", "ae"), Normalizer.Form.NFD)
            .replace(DIACRITICS, "")

    private fun isSep(c: Char) = !(c in 'a'..'z' || c in '0'..'9')

    /**
     * Champs pondérés : nom ×1, nom + identifiant et identifiant + nom ×0,9, hôtes ×0,8, identifiant ×0,7,
     * dossier ×0,5. Calculés une fois par entrée déchiffrée, avec leurs mots pré-découpés.
     */
    class Fields(val name: String, val both: String, val rev: String, val host: String, val username: String, val folder: String) {
        val all = arrayOf(name, both, rev, host, username, folder)
        val words: Array<Array<String>> = Array(all.size) { words(all[it]) }
        val nameWords get() = words[0]
        val userWords get() = words[4]
    }

    private fun words(s: String): Array<String> =
        if (s.isEmpty()) emptyArray() else s.split(SEP).filter { it.isNotEmpty() }.toTypedArray()

    private val WEIGHTS = doubleArrayOf(1.0, 0.9, 0.9, 0.8, 0.7, 0.5)

    fun fields(it: Item): Fields {
        val name = fold(it.name)
        val username = fold(it.username)
        return Fields(
            name,
            if (username.isEmpty()) "" else "$name $username", // « applis » → « Apple » + « lisa »
            if (username.isEmpty()) "" else "$username $name", // « lisapple » → « lisa » + « Apple »
            it.uris.joinToString(" ") { u -> fold(Domains.hostOf(u)).replace(WWW, "") },
            username,
            fold(it.folder),
        )
    }

    /**
     * Découpe titre/identifiant : 80 si t[0:k] commence un mot de [a] (ou, si k ≥ 3, apparaît dans [a])
     * et t[k:] commence un mot de [b] (2 ≤ k ≤ len(t) − 2). Ex. « lisapp » → « lis » + « app ».
     */
    fun splitScore(t: String, a: String, b: String): Int = splitScore(t, a, words(a), words(b))

    /** Version sans allocation, mots pré-découpés. */
    private fun splitScore(t: String, a: String, wa: Array<String>, wb: Array<String>): Int {
        if (t.length < 4 || a.isEmpty() || wb.isEmpty()) return 0
        for (k in 2..t.length - 2) {
            val rest = t.length - k
            var second = false
            for (w in wb) if (w.length >= rest && w.regionMatches(0, t, k, rest)) { second = true; break }
            if (!second) continue
            for (w in wa) if (w.length >= k && w.regionMatches(0, t, 0, k)) return 80
            if (k >= 3) for (i in 0..a.length - k) if (a.regionMatches(i, t, 0, k)) return 80
        }
        return 0
    }

    /** Math.round de JavaScript (demi vers +∞). */
    private fun jsRound(x: Double): Int = Math.floor(x + 0.5).toInt()

    /** Distance de Damerau-Levenshtein (transpositions adjacentes), bornée à max+1. */
    fun editDistance(a: String, b: String, max: Int): Int = editDistance(a, b, b.length, max)

    /** Idem sur les [blen] premiers caractères de [b] (pas de sous-chaîne allouée). */
    private fun editDistance(a: String, b: String, blen: Int, max: Int): Int {
        if (Math.abs(a.length - blen) > max) return max + 1
        var prev2 = IntArray(blen + 1)
        var prev = IntArray(blen + 1) { it }
        var cur = IntArray(blen + 1)
        for (i in 1..a.length) {
            cur[0] = i
            var rowMin = i
            for (j in 1..blen) {
                var v = minOf(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (if (a[i - 1] == b[j - 1]) 0 else 1))
                if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1]) v = minOf(v, prev2[j - 2] + 1)
                cur[j] = v
                if (v < rowMin) rowMin = v
            }
            if (rowMin > max) return max + 1
            val t = prev2; prev2 = prev; prev = cur; cur = t
        }
        return prev[blen]
    }

    /** Score d'un terme dans un champ (0 = absent). */
    fun termScore(t: String, field: String): Int = termScore(t, field, words(field))

    private fun termScore(t: String, field: String, fieldWords: Array<String>): Int {
        if (field.isEmpty() || t.isEmpty()) return 0
        val i = field.indexOf(t)
        if (i == 0) return 100
        if (i > 0) return if (isSep(field[i - 1])) 90 else 70
        if (t.length < 3) return 0
        // lettres dans l'ordre, la première en début de mot, sur une étendue d'au plus 3× la longueur
        var best = 0
        val t0 = t[0]
        for (start in field.indices) {
            if (field[start] != t0 || (start > 0 && !isSep(field[start - 1]))) continue
            var k = 1
            var j = start + 1
            while (j < field.length && k < t.length) {
                if (field[j] == t[k]) k++
                j++
            }
            if (k == t.length) {
                val span = j - start
                if (span <= t.length * 3) best = maxOf(best, jsRound(30 + 30.0 * t.length / span))
            }
        }
        if (best != 0) return best
        if (t.length < 4) return 0
        val max = if (t.length >= 8) 2 else 1
        for (w in fieldWords) {
            if (w.length < 2) continue
            if (editDistance(t, w, w.length, max) <= max || (w.length > t.length && editDistance(t, w, t.length, max) <= max)) return 40
        }
        return 0
    }

    fun searchScore(it: Item, terms: List<String>): Double {
        val f = it.fz
        val fs = f.all
        var total = 0.0
        for (t in terms) {
            var best = 0.0
            for (k in fs.indices) {
                best = maxOf(best, termScore(t, fs[k], f.words[k]) * WEIGHTS[k])
                if (best >= 100.0) break // maximum possible (début du nom) : inutile de chercher ailleurs
            }
            if (best < 100.0) {
                best = maxOf(best, maxOf(splitScore(t, f.username, f.userWords, f.nameWords), splitScore(t, f.name, f.nameWords, f.userWords)) * 0.9)
            }
            if (best == 0.0) return 0.0
            total += best
        }
        return total + if (it.fav) 5 else 0
    }

    /**
     * Requête vide : toutes les entrées, favorites d'abord, puis par nom ; sinon celles qui
     * contiennent tous les termes, par score décroissant puis par fold(nom) (ordre des points de code).
     */
    fun search(items: Collection<Item>, query: String): List<Item> {
        val terms = fold(query).split(SPACES).filter { it.isNotEmpty() }
        val scored = ArrayList<Triple<Double, String, Item>>()
        for (it in items) {
            val score = if (terms.isNotEmpty()) searchScore(it, terms) else if (it.fav) 1.0 else 0.0
            if (terms.isNotEmpty() && score == 0.0) continue
            scored.add(Triple(score, it.fz.name, it))
        }
        scored.sortWith { a, b -> if (a.first != b.first) b.first.compareTo(a.first) else a.second.compareTo(b.second) }
        return scored.map { it.third }
    }
}
