package app.biopass.passkey

import android.content.Context
import androidx.annotation.RequiresApi
import androidx.credentials.provider.CallingAppInfo
import app.biopass.R
import app.biopass.autofill.appLabel
import app.biopass.core.AssetLinks
import app.biopass.core.WebAuthn
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/**
 * Appelant d'une demande de clé d'accès. [origin] est signée dans clientDataJSON : adresse de la page
 * (navigateur) ou empreinte du certificat de l'appli (`android:apk-key-hash:…`).
 */
class Caller(val origin: String, val pkg: String, val browser: Boolean) {
    /** Paquet inscrit dans clientDataJSON (applis seulement). */
    val androidPackage get() = if (browser) null else pkg
}

/**
 * Qui a le droit d'utiliser les clés d'un site : un navigateur reconnu (liste publiée par Google,
 * res/raw/privileged_browsers.json, versions « release ») dont la page est sur ce domaine, ou une appli
 * que le site déclare lui-même (Digital Asset Links). Sans cela, une appli malveillante pourrait se
 * connecter à votre banque à votre place.
 */
@RequiresApi(34)
object Callers {
    @Volatile private var allowlist: String? = null
    private val links = ConcurrentHashMap<String, Pair<Long, String>>() // rpId → (date, assetlinks.json)

    private fun allowlist(ctx: Context): String = allowlist
        ?: ctx.resources.openRawResource(R.raw.privileged_browsers).bufferedReader().use { it.readText() }.also { allowlist = it }

    /** Origine web transmise par un navigateur reconnu ; null pour une appli (ou un navigateur inconnu). */
    fun browserOrigin(ctx: Context, info: CallingAppInfo): String? = try {
        info.getOrigin(allowlist(ctx))?.trimEnd('/')?.takeIf { it.isNotEmpty() }
    } catch (e: IllegalStateException) {
        null // origine fournie par une appli absente de la liste : ignorée
    } catch (e: IllegalArgumentException) {
        null
    }

    fun certSha256(info: CallingAppInfo): ByteArray? =
        info.signingInfo.apkContentsSigners.firstOrNull()?.toByteArray()?.let { WebAuthn.sha256(it) }

    /** Vérifie l'appelant pour [rpId]. Peut interroger le site (réseau) : hors du thread UI. */
    fun resolve(ctx: Context, info: CallingAppInfo, rpId: String): Caller {
        browserOrigin(ctx, info)?.let { origin ->
            if (!WebAuthn.rpIdAllowed(rpId, origin)) throw SecurityException("Cette page ne peut pas utiliser les clés d'accès de $rpId")
            return Caller(origin, info.packageName, true)
        }
        val cert = certSha256(info) ?: throw SecurityException("Application non identifiable")
        if (!AssetLinks.allows(assetLinks(rpId), info.packageName, cert)) {
            throw SecurityException("${appLabel(ctx, info.packageName)} n'est pas autorisée par $rpId à utiliser ses clés d'accès")
        }
        return Caller(WebAuthn.appOrigin(cert), info.packageName, false)
    }

    /** `https://<rpId>/.well-known/assetlinks.json`, sans redirection (règle Digital Asset Links), gardé 1 h. */
    private fun assetLinks(rpId: String): String {
        links[rpId]?.let { (t, json) -> if (System.currentTimeMillis() - t < 3_600_000) return json }
        val c = URL("https://$rpId/.well-known/assetlinks.json").openConnection() as HttpURLConnection
        try {
            c.instanceFollowRedirects = false
            c.connectTimeout = 5000
            c.readTimeout = 5000
            if (c.responseCode != 200) throw SecurityException("$rpId ne déclare aucune application autorisée")
            val json = c.inputStream.use { s -> String(s.readNBytes(512 * 1024), Charsets.UTF_8) }
            links[rpId] = System.currentTimeMillis() to json
            return json
        } catch (e: java.io.IOException) {
            throw SecurityException("Vérification de l'application impossible ($rpId injoignable)")
        } finally {
            c.disconnect()
        }
    }
}
