package app.biopass.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/** Banc d'essai de la recherche : 1 000 entrées réalistes, requêtes tapées lettre par lettre. */
class SearchBenchTest {
    private fun vault(n: Int): List<Item> {
        val rnd = Random(42)
        val brands = listOf("GitHub", "GitLab", "Google", "Amazon", "Apple ID", "Banque Populaire", "Crédit Agricole", "Impôts", "Netflix",
            "Free Mobile", "Orange", "SNCF Connect", "Ameli", "La Poste", "Leboncoin", "Doctolib", "Spotify", "Deezer", "Twitter", "Facebook",
            "Instagram", "LinkedIn", "Microsoft", "Dropbox", "OVH", "Infomaniak", "Proton Mail", "Boîte mail", "Wi-Fi maison", "Œuvre caritative",
            "EDF", "Engie", "Fnac", "Darty", "Cdiscount", "Vinted", "Uber", "Airbnb", "Booking", "Decathlon")
        val people = listOf("fabio", "lisa", "marie", "paul", "jeanne", "luc", "martin", "famille")
        val domains = listOf("gmail.com", "example.net", "icloud.com", "proton.me", "orange.fr")
        val folders = listOf("", "", "Dev", "Finances", "Maison", "Administratif", "Loisirs", "Serveurs")
        return (0 until n).map { i ->
            val brand = brands[rnd.nextInt(brands.size)]
            val name = if (rnd.nextInt(3) == 0) "$brand ${rnd.nextInt(100)}" else brand
            val person = people[rnd.nextInt(people.size)]
            val user = when (rnd.nextInt(4)) {
                0 -> ""
                1 -> person
                else -> "$person${if (rnd.nextBoolean()) "." + people[rnd.nextInt(people.size)] else ""}@${domains[rnd.nextInt(domains.size)]}"
            }
            val host = Search.fold(brand).replace(Regex("[^a-z0-9]"), "") + listOf(".com", ".fr", ".net")[rnd.nextInt(3)]
            Item("id$i", 1, JSONObject().put("name", name).put("username", user).put("folder", folders[rnd.nextInt(folders.size)])
                .put("uris", JSONArray(listOf("https://www.$host/login"))).put("fav", rnd.nextInt(20) == 0))
        }
    }

    private val queries = listOf("g", "gi", "git", "gthb", "a", "am", "amz", "amza", "amzao", "amzaon", "l", "li", "lis", "lisa", "lisap", "lisapp")

    @Test fun banc() {
        val items = vault(1000)
        // 1er passage : inclut le calcul des champs « pliés » (une fois par entrée déchiffrée)
        var t0 = System.nanoTime()
        for (q in queries) Search.search(items, q)
        val first = (System.nanoTime() - t0) / 1e6
        // passages suivants (JIT chaud) : coût d'une frappe
        repeat(5) { for (q in queries) Search.search(items, q) }
        val runs = 20
        t0 = System.nanoTime()
        var found = 0
        repeat(runs) { for (q in queries) found += Search.search(items, q).size }
        val perQuery = (System.nanoTime() - t0) / 1e6 / (runs * queries.size)
        val worst = queries.maxByOrNull { q ->
            val s = System.nanoTime(); repeat(10) { Search.search(items, q) }; System.nanoTime() - s
        }
        println("BANC recherche 1000 entrées : 1er passage (16 requêtes) %.1f ms ; ensuite %.3f ms/requête ; requête la plus lente : « %s »"
            .format(first, perQuery, worst))
        assertTrue(found > 0)
    }
}
