package app.biopass.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class FieldsTest {
    private val TEXT = 0x01
    private val PASSWORD = 0x81
    private val WEB_PASSWORD = 0xe1
    private val VISIBLE_PASSWORD = 0x91
    private val EMAIL = 0x21
    private val NUMBER = 0x02
    private val NUMBER_PASSWORD = 0x12

    private fun f(name: String, inputType: Int = TEXT, hints: List<String> = emptyList(), idEntry: String? = null,
                  hint: String? = null, tag: String? = null, attrs: Map<String, String> = emptyMap(), text: Boolean = true) =
        FieldInfo(name, text, hints = hints, inputType = inputType, htmlTag = tag, htmlAttrs = attrs, idEntry = idEntry, hint = hint)

    private fun kind(fi: FieldInfo) = FieldClassifier.classify(fi)

    @Test fun indicesEtTypes() {
        assertEquals(Kind.PASSWORD, kind(f("a", hints = listOf("password"))))
        assertEquals(Kind.USERNAME, kind(f("a", hints = listOf("emailAddress"))))
        assertEquals(Kind.OTP, kind(f("a", hints = listOf("smsOTPCode"))))
        assertEquals(Kind.PASSWORD, kind(f("a", PASSWORD)))
        assertEquals(Kind.PASSWORD, kind(f("a", WEB_PASSWORD)))
        assertEquals(Kind.PASSWORD, kind(f("a", VISIBLE_PASSWORD)))
        assertEquals(Kind.USERNAME, kind(f("a", VISIBLE_PASSWORD, idEntry = "login_field")))
        assertEquals(Kind.USERNAME, kind(f("a", EMAIL)))
        assertEquals(Kind.PASSWORD, kind(f("a", NUMBER_PASSWORD)))
        assertEquals(Kind.OTP, kind(f("a", NUMBER_PASSWORD, hint = "Code de vérification")))
        assertEquals(Kind.OTHER, kind(f("a", hints = listOf("postalCode"))))
    }

    @Test fun heuristiquesFrEn() {
        assertEquals(Kind.USERNAME, kind(f("a", idEntry = "et_identifiant")))
        assertEquals(Kind.USERNAME, kind(f("a", hint = "Adresse e-mail")))
        assertEquals(Kind.USERNAME, kind(f("a", hint = "Pseudo")))
        assertEquals(Kind.PASSWORD, kind(f("a", hint = "Mot de passe")))
        assertEquals(Kind.PASSWORD, kind(f("a", idEntry = "mdp")))
        assertEquals(Kind.OTP, kind(f("a", NUMBER, hint = "Code reçu par SMS")))
        assertEquals(Kind.OTP, kind(f("a", idEntry = "otp_input")))
        assertEquals(Kind.OTHER, kind(f("a", hint = "Code postal")))
        assertEquals(null, kind(f("a", hint = "Rechercher")))
        assertEquals(Kind.OTHER, kind(f("a", hint = "Prénom")))
        assertEquals(null, kind(f("a", text = false)))
    }

    @Test fun html() {
        val input = "input"
        assertEquals(Kind.PASSWORD, kind(f("a", tag = input, attrs = mapOf("type" to "password", "name" to "pass"))))
        assertEquals(Kind.USERNAME, kind(f("a", tag = input, attrs = mapOf("type" to "email"))))
        assertEquals(Kind.USERNAME, kind(f("a", tag = input, attrs = mapOf("type" to "text", "autocomplete" to "username"))))
        assertEquals(Kind.OTP, kind(f("a", tag = input, attrs = mapOf("type" to "text", "autocomplete" to "one-time-code"))))
        assertEquals(Kind.PASSWORD, kind(f("a", tag = input, attrs = mapOf("type" to "text", "autocomplete" to "current-password"))))
        assertEquals(null, kind(f("a", tag = input, attrs = mapOf("type" to "submit"))))
        assertEquals(null, kind(f("a", tag = input, attrs = mapOf("type" to "hidden", "name" to "password"))))
        assertEquals(null, kind(f("a", tag = "div")))
    }

    @Test fun formulaires() {
        // Identifiant non reconnaissable avant un mot de passe → utilisé comme identifiant
        val a = FieldClassifier.analyze(listOf(f("nom", hint = "Votre numéro client"), f("pw", PASSWORD)))
        assertEquals(listOf("nom"), a.usernames.map { it.ref })
        assertEquals(listOf("pw"), a.passwords.map { it.ref })
        // Formulaire en deux étapes : identifiant seul
        val b = FieldClassifier.analyze(listOf(f("u", EMAIL)))
        assertEquals(listOf("u"), b.usernames.map { it.ref })
        assertTrue(b.passwords.isEmpty())
        // Rien d'intéressant
        assertTrue(FieldClassifier.analyze(listOf(f("x", hint = "Rechercher"), f("y", hint = "Message"))).isEmpty)
        // Recherche + login : la recherche n'est pas prise comme identifiant
        val c = FieldClassifier.analyze(listOf(f("s", hint = "Search"), f("u", idEntry = "username"), f("p", PASSWORD)))
        assertEquals(listOf("u"), c.usernames.map { it.ref })
    }

    /** Vérifie la syntaxe des pathData des vector drawables (une erreur ferait planter l'app au rendu). */
    @Test fun vecteursValides() {
        val dir = listOf(File("src/main/res/drawable"), File("app/src/main/res/drawable")).first { it.isDirectory }
        val args = mapOf('m' to 2, 'l' to 2, 'h' to 1, 'v' to 1, 'c' to 6, 's' to 4, 'q' to 4, 't' to 2, 'a' to 7, 'z' to 0)
        var n = 0
        for (file in dir.listFiles()!!.filter { it.name.endsWith(".xml") }) {
            for (m in Regex("pathData=\"([^\"]*)\"").findAll(file.readText())) {
                val d = m.groupValues[1]
                assertTrue("${file.name}: caractère invalide", d.all { it in "MmLlHhVvCcSsQqTtAaZz0123456789.,- eE" })
                val tokens = Regex("[A-Za-z]|-?(\\d+\\.?\\d*|\\.\\d+)([eE]-?\\d+)?").findAll(d).map { it.value }.toList()
                assertTrue("${file.name}: doit commencer par M", tokens.first() in listOf("M", "m"))
                var cmd = ' '
                var count = 0
                fun check() {
                    val k = args.getValue(cmd.lowercaseChar())
                    assertTrue("${file.name}: $cmd a $count arguments", if (k == 0) count == 0 else count > 0 && count % k == 0)
                }
                for (t in tokens) {
                    if (t[0].isLetter()) {
                        if (cmd != ' ') check()
                        cmd = t[0]; count = 0
                    } else count++
                }
                check()
                n++
            }
        }
        assertTrue(n > 20)
    }
}

class ChipLabelsTest {
    private fun it(name: String, user: String) = Item(name + user, 1, org.json.JSONObject().put("name", name).put("username", user))

    @Test fun libelles() {
        val l = chipLabels(listOf(it("Apple", "lisa"), it("Apple", "fabio"), it("iCloud", "lisa"), it("Wi-Fi", ""),
            it("Banque", "un.identifiant.vraiment.tres.long@exemple.fr"), it("", "")))
        assertEquals(listOf("lisa · Apple", "fabio", "lisa · iCloud", "Wi-Fi", "un.identifiant.vraiment…", "(sans nom)"), l)
    }
}

class PaletteTest {
    @Test fun couleurStable() {
        // vecteurs de référence FNV-1a 32 bits
        assertEquals(0x811c9dc5.toInt(), Palette.fnv1a(""))
        assertEquals(0xe40c292c.toInt(), Palette.fnv1a("a"))
        assertEquals(0xbf9cf968.toInt(), Palette.fnv1a("foobar"))
        fun it(name: String, user: String) = Item("x", 1, org.json.JSONObject().put("name", name).put("username", user))
        // même identifiant (casse / accents / espaces) → même couleur, quel que soit le nom
        assertEquals(Palette.index(it("Apple", "Lisa")), Palette.index(it("iCloud", " lisa ")))
        assertEquals(Palette.index(it("Élodie", "")), Palette.index(it("elodie", "")))
        // répartition : 200 identifiants différents occupent toute la palette
        val used = (0 until 200).map { Palette.index(it("n", "user$it@exemple.fr")) }.toSet()
        assertEquals(Palette.COLORS.size, used.size)
        assertEquals(12, Palette.COLORS.size)
    }
}

class KindTest {
    private fun it(name: String, uris: List<String> = emptyList(), type: String? = null, fields: List<String> = emptyList()) =
        Item("x", 1, org.json.JSONObject().put("name", name).put("uris", org.json.JSONArray(uris)).apply {
            if (type != null) put("type", type)
            put("fields", org.json.JSONArray(fields.map { f -> org.json.JSONObject().put("name", f).put("value", "1") }))
        })

    @Test fun categories() {
        assertEquals("network", Kinds.of(it("Routeur", listOf("http://192.168.1.1"))))
        assertEquals("network", Kinds.of(it("NAS", listOf("https://nas.local:5001"))))
        assertEquals("terminal", Kinds.of(it("Serveur perso", listOf("ssh://root@vps.exemple.fr"))))
        assertEquals("network", Kinds.of(it("Machine", listOf("ssh://admin@203.0.113.10")))) // IP avant SSH (même ordre que core.js)
        assertEquals("wifi", Kinds.of(it("Wi-Fi maison")))
        assertEquals("card", Kinds.of(it("Visa", fields = listOf("Numéro", "Code"))))
        assertEquals("card", Kinds.of(it("Paiement", listOf("https://shop.fr"), fields = listOf("Numéro", "Exp."))))
        assertEquals("key", Kinds.of(it("Clé API OpenAI")))
        assertEquals("app", Kinds.of(it("Banque", listOf("androidapp://com.banque"))))
        assertEquals("note", Kinds.of(it("Codes de secours", type = "note", uris = listOf("https://github.com"))))
        assertEquals("note", Kinds.of(it("Divers")))
        assertEquals(null, Kinds.of(it("GitHub", listOf("https://github.com"))))
        assertEquals(null, Kinds.of(it("Mon apiculteur", listOf("https://miel.fr")))) // « api » pas en début de mot isolé
        assertEquals("key", Kinds.of(it("api-github", listOf("https://github.com"))))
        // règle réseau : IPv4 stricte, IPv6 entre crochets, localhost, domaines locaux
        assertEquals(null, Kinds.of(it("AB", listOf("https://ab12.fe"))))
        assertEquals(null, Kinds.of(it("Café", listOf("https://cafe1.be"))))
        assertEquals("network", Kinds.of(it("Local v6", listOf("http://[::1]:8080"))))
        assertEquals("network", Kinds.of(it("Box", listOf("http://box.localdomain"))))
        assertEquals("network", Kinds.of(it("Dev", listOf("http://localhost:3000"))))
        assertEquals(null, Kinds.of(it("Version", listOf("https://1.2.3.4.5"))))
    }
}
