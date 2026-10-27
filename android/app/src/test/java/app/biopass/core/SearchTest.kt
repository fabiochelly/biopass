package app.biopass.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** Recherche approximative : doit reproduire core.js à l'identique (tools/search-vectors.json). */
class SearchTest {
    private val v = JSONObject(javaClass.getResource("/search-vectors.json")!!.readText())

    @Test fun fold() {
        val f = v.getJSONArray("fold")
        for (i in 0 until f.length()) {
            val pair = f.getJSONArray(i)
            assertEquals(pair.getString(1), Search.fold(pair.getString(0)))
        }
        assertEquals("ca va", Search.fold("ÇA VA"))
    }

    @Test fun vecteurs() {
        val arr = v.getJSONArray("items")
        val items = (0 until arr.length()).map { Item("id$it", 1, arr.getJSONObject(it)) }
        val vec = v.getJSONArray("vectors")
        for (i in 0 until vec.length()) {
            val q = vec.getJSONObject(i)
            val exp = q.getJSONArray("results").let { a -> (0 until a.length()).map { a.getString(it) } }
            assertEquals("requête « ${q.getString("query")} »", exp, Search.search(items, q.getString("query")).map { it.name })
        }
        println("Recherche : ${vec.length()} requêtes identiques à core.js")
    }

    @Test fun details() {
        assertEquals(1, Search.editDistance("githbu", "github", 1))
        assertEquals(2, Search.editDistance("abcd", "xycd", 1)) // borné à max+1
        assertEquals(100, Search.termScore("git", "github"))
        assertEquals(90, Search.termScore("pop", "banque populaire"))
        assertEquals(70, Search.termScore("hub", "github"))
        assertEquals(50, Search.termScore("gthb", "github")) // 30 + 30×4/6
        assertEquals(53, Search.termScore("abd", "abcd")) // 52,5 → arrondi JS vers +∞
        assertEquals(40, Search.termScore("amzaon", "amazon")) // transposition
    }
}

class SplitScoreTest {
    @Test fun decoupe() {
        assertEquals(80, Search.splitScore("lisapp", "lisamartin@icloud.example", "apple id"))
        assertEquals(80, Search.splitScore("applis", "apple", "lisa"))
        assertEquals(0, Search.splitScore("lis", "lisa", "apple")) // trop court
        assertEquals(0, Search.splitScore("lisxyz", "lisa", "apple"))
        assertEquals(0, Search.splitScore("lisapp", "", "apple"))
    }
}
