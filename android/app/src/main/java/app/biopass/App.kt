package app.biopass

import android.app.Application
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.os.SystemClock
import android.widget.Toast
import app.biopass.core.ApiError
import app.biopass.core.Store
import app.biopass.core.Vault
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

class BioApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Session.init(this)
    }
}

/**
 * Cache local : un seul fichier `{profile:{…}, vault:{rev, items}}` dans filesDir.
 * Ne contient que des données chiffrées + salt/iter/wrapped (jamais de clair, jamais le token).
 */
class FileStore(private val file: File) : Store {
    private var root: JSONObject? = null

    @Synchronized private fun data(): JSONObject {
        root?.let { return it }
        val r = try {
            if (file.exists()) JSONObject(file.readText()) else JSONObject()
        } catch (e: Exception) {
            JSONObject()
        }
        root = r
        return r
    }

    @Synchronized private fun flush() {
        val tmp = File(file.path + ".tmp")
        java.io.FileOutputStream(tmp).use {
            it.write(data().toString().toByteArray(Charsets.UTF_8))
            it.fd.sync()
        }
        if (!tmp.renameTo(file)) throw java.io.IOException("Écriture du cache impossible")
    }

    @Synchronized override fun get(key: String): JSONObject? = data().optJSONObject(key)?.let { JSONObject(it.toString()) }
    @Synchronized override fun set(key: String, value: JSONObject) {
        data().put(key, JSONObject(value.toString())); flush()
    }
    @Synchronized override fun remove(key: String) {
        data().remove(key); flush()
    }
}

/** État du processus : coffre (clé en mémoire uniquement), verrouillage auto, thread de fond. */
object Session {
    lateinit var app: Context
        private set
    lateinit var vault: Vault
        private set
    lateinit var prefs: SharedPreferences
        private set
    private val io = Executors.newSingleThreadExecutor()
    val main = Handler(Looper.getMainLooper())
    private var lastUse = 0L
    private var clipSeq = 0

    fun init(ctx: Context) {
        if (::app.isInitialized) return
        app = ctx.applicationContext
        prefs = app.getSharedPreferences("biopass", Context.MODE_PRIVATE)
        vault = Vault(FileStore(File(app.filesDir, "cache.json")))
        vault.load()
        // « Ne jamais verrouiller » : réouverture sans mot de passe, connexion en arrière-plan.
        if (lockMinutes == 0 && Keep.restore()) {
            io.execute {
                try {
                    vault.reconnect()
                } catch (e: ApiError) {
                    if (e.status == 401) main.post { lock() } // mot de passe changé ailleurs
                } catch (e: Exception) { /* hors ligne : on réessaiera */ }
            }
        }
    }

    /** Délai de verrouillage auto en minutes (0 = jamais, même après redémarrage du téléphone). */
    var lockMinutes: Int
        get() = prefs.getInt("lockMinutes", 5)
        set(v) {
            prefs.edit().putInt("lockMinutes", v).apply()
            if (v == 0 && vault.unlocked) Keep.save() else if (v != 0) Keep.clear()
        }

    /** À appeler après chaque déverrouillage réussi (mot de passe, empreinte, configuration). */
    fun onUnlocked() {
        touch()
        if (lockMinutes == 0) Keep.save()
    }

    fun touch() {
        lastUse = SystemClock.elapsedRealtime()
        val m = lockMinutes
        main.removeCallbacks(idleCheck)
        if (m > 0) main.postDelayed(idleCheck, m * 60_000L + 500)
    }

    private val idleCheck = Runnable { checkIdle() }

    /** Verrouille si le délai d'inactivité est dépassé. Retourne true si le coffre est verrouillé. */
    fun checkIdle(): Boolean {
        val m = lockMinutes
        if (vault.unlocked && m > 0 && SystemClock.elapsedRealtime() - lastUse > m * 60_000L) lock()
        return !vault.unlocked
    }

    val unlocked get() = !checkIdle()
    val hasProfile get() = vault.profile != null

    /** Verrouillage (manuel, délai, session refusée) : efface aussi la conservation « jamais ». */
    fun lock() {
        main.removeCallbacks(idleCheck)
        vault.lock()
        Keep.clear()
    }

    /** Exécute [work] sur le thread de fond (sérialisé), puis [done] sur le thread UI. */
    fun <T> run(work: () -> T, done: (Result<T>) -> Unit) {
        io.execute {
            val r = runCatching(work)
            main.post { done(r) }
        }
    }

    /** Copie marquée sensible ; effacée au bout de 60 s si elle est toujours la nôtre. */
    fun copy(ctx: Context, label: String, text: String, sensitive: Boolean = true) {
        val cm = ctx.getSystemService(ClipboardManager::class.java)
        val clip = ClipData.newPlainText("BioPass", text)
        if (sensitive && Build.VERSION.SDK_INT >= 33) {
            clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        }
        cm.setPrimaryClip(clip)
        // Android 13+ affiche sa propre confirmation de copie.
        if (Build.VERSION.SDK_INT < 33) Toast.makeText(ctx, "$label copié", Toast.LENGTH_SHORT).show()
        if (!sensitive) return
        val seq = ++clipSeq
        main.postDelayed({
            if (seq != clipSeq) return@postDelayed
            try {
                val d = cm.primaryClipDescription
                if (d != null && d.label == "BioPass") cm.clearPrimaryClip()
            } catch (e: Exception) { /* presse-papiers inaccessible en arrière-plan */ }
        }, 60_000)
    }
}
