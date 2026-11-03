package app.biopass.passkey

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.CancellationSignal
import android.os.OutcomeReceiver
import androidx.annotation.RequiresApi
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.provider.AuthenticationAction
import androidx.credentials.provider.BeginCreateCredentialRequest
import androidx.credentials.provider.BeginCreateCredentialResponse
import androidx.credentials.provider.BeginCreatePasswordCredentialRequest
import androidx.credentials.provider.BeginCreatePublicKeyCredentialRequest
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPasswordOption
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.CreateEntry
import androidx.credentials.provider.CredentialEntry
import androidx.credentials.provider.CredentialProviderService
import androidx.credentials.provider.PasswordCredentialEntry
import androidx.credentials.provider.ProviderClearCredentialStateRequest
import androidx.credentials.provider.PublicKeyCredentialEntry
import app.biopass.Session
import app.biopass.core.Domains
import app.biopass.core.Item
import app.biopass.core.Passkey
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/**
 * Fournisseur d'identifiants d'Android 14+ (« Service préféré » dans Mots de passe, clés d'accès et
 * comptes) : passkeys et mots de passe demandés par les applis et les navigateurs. Ce service ne
 * fait que lister ; tout ce qui signe ou révèle un secret passe par [PasskeyActivity] (empreinte).
 */
@RequiresApi(34)
class PasskeyService : CredentialProviderService() {
    override fun onBeginGetCredentialRequest(
        request: BeginGetCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>,
    ) {
        Session.init(this)
        if (!Session.hasProfile) return callback.onResult(BeginGetCredentialResponse())
        if (!Session.unlocked) {
            // coffre chiffré : on ne sait pas encore ce qu'il contient ; le déverrouiller liste les comptes
            val unlock = AuthenticationAction("Déverrouiller BioPass", Entries.pending(this, PasskeyActivity.MODE_UNLOCK))
            return callback.onResult(BeginGetCredentialResponse(emptyList(), emptyList(), listOf(unlock), null))
        }
        callback.onResult(Entries.response(this, request))
    }

    override fun onBeginCreateCredentialRequest(
        request: BeginCreateCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException>,
    ) {
        Session.init(this)
        val mode = when (request) {
            is BeginCreatePublicKeyCredentialRequest -> PasskeyActivity.MODE_CREATE_PASSKEY
            is BeginCreatePasswordCredentialRequest -> PasskeyActivity.MODE_CREATE_PASSWORD
            else -> null
        }
        if (mode == null || !Session.hasProfile) return callback.onResult(BeginCreateCredentialResponse())
        val entry = CreateEntry.Builder(Session.vault.profile?.user ?: "BioPass", Entries.pending(this, mode))
            .setDescription(if (mode == PasskeyActivity.MODE_CREATE_PASSKEY) "Clé d'accès enregistrée dans votre coffre BioPass" else "Mot de passe enregistré dans votre coffre BioPass")
            .build()
        callback.onResult(BeginCreateCredentialResponse(listOf(entry), null))
    }

    override fun onClearCredentialStateRequest(
        request: ProviderClearCredentialStateRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<Void?, ClearCredentialException>,
    ) = callback.onResult(null)
}

/** Entrées du sélecteur système (aussi construites par [PasskeyActivity] après un déverrouillage). */
@RequiresApi(34)
object Entries {
    const val ITEM = "item"
    const val CRED = "cred"
    private val code = AtomicInteger()

    /** Une PendingIntent distincte par entrée (le système y ajoute la demande : FLAG_MUTABLE). */
    fun pending(ctx: Context, mode: String, item: String? = null, cred: String? = null): PendingIntent {
        val n = code.incrementAndGet()
        val i = Intent(ctx, PasskeyActivity::class.java).setAction("app.biopass.passkey.$mode.$n")
            .putExtra(PasskeyActivity.MODE, mode).putExtra(ITEM, item).putExtra(CRED, cred)
        return PendingIntent.getActivity(ctx, n, i, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** Clés d'accès de [rpId] (et, si non vide, parmi les identifiants autorisés par le site). */
    fun passkeysFor(rpId: String, allow: Set<String> = emptySet()): List<Pair<Item, Passkey>> =
        Session.vault.list().flatMap { it -> it.passkeys.map { pk -> it to pk } }
            .filter { (_, pk) -> pk.rpId.equals(rpId, ignoreCase = true) && (allow.isEmpty() || pk.credentialId in allow) }

    /** Entrées à mot de passe de l'appelant : page d'un navigateur reconnu, ou appli associée à l'entrée. */
    fun passwordsFor(origin: String?, pkg: String?): List<Item> = Session.vault.list().filter {
        it.password.isNotEmpty() && if (origin != null) Domains.matchesUrl(it, origin) else pkg != null && Domains.matchesApp(it, pkg)
    }

    private fun icon(it: Item): Icon? = it.iconBytes()?.let { b -> Icon.createWithData(b, 0, b.size) }

    fun response(ctx: Context, request: BeginGetCredentialRequest): BeginGetCredentialResponse {
        val info = request.callingAppInfo
        val origin = info?.let { Callers.browserOrigin(ctx, it) }
        val entries = ArrayList<CredentialEntry>()
        for (opt in request.beginGetCredentialOptions) {
            when (opt) {
                is BeginGetPublicKeyCredentialOption -> {
                    val json = try { JSONObject(opt.requestJson) } catch (e: Exception) { continue }
                    val rpId = json.optString("rpId").ifEmpty { origin?.let { o -> android.net.Uri.parse(o).host } ?: "" }
                    if (rpId.isEmpty()) continue
                    val allow = json.optJSONArray("allowCredentials")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it)?.optString("id") }.toSet() } ?: emptySet()
                    for ((it, pk) in passkeysFor(rpId, allow)) {
                        entries += PublicKeyCredentialEntry.Builder(ctx, pk.userName.ifEmpty { pk.userDisplayName.ifEmpty { it.username } },
                            pending(ctx, PasskeyActivity.MODE_GET_PASSKEY, it.id, pk.credentialId), opt)
                            .setDisplayName(it.name.ifEmpty { pk.rpName.ifEmpty { pk.rpId } })
                            .apply { icon(it)?.let { i -> setIcon(i) } }
                            .build()
                    }
                }
                is BeginGetPasswordOption -> {
                    for (it in passwordsFor(origin, info?.packageName)) {
                        entries += PasswordCredentialEntry.Builder(ctx, it.username.ifEmpty { it.name },
                            pending(ctx, PasskeyActivity.MODE_GET_PASSWORD, it.id), opt)
                            .setDisplayName(it.name)
                            .apply { icon(it)?.let { i -> setIcon(i) } }
                            .build()
                    }
                }
            }
        }
        return BeginGetCredentialResponse(entries, emptyList(), emptyList(), null)
    }
}
