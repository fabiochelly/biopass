package app.biopass.passkey

import android.content.Intent
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Bundle
import android.os.CancellationSignal
import android.os.SystemClock
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.Toast
import androidx.annotation.RequiresApi
import androidx.credentials.CreatePasswordRequest
import androidx.credentials.CreatePasswordResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPasswordOption
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PasswordCredential
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.domerrors.InvalidStateError
import androidx.credentials.exceptions.domerrors.NotAllowedError
import androidx.credentials.exceptions.domerrors.NotSupportedError
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import androidx.credentials.provider.CallingAppInfo
import androidx.credentials.provider.PendingIntentHandler
import app.biopass.BaseActivity
import app.biopass.BtnStyle
import app.biopass.MATCH
import app.biopass.MEDIUM
import app.biopass.R
import app.biopass.Session
import app.biopass.UnlockPanel
import app.biopass.WRAP
import app.biopass.autofill.PendingSave
import app.biopass.autofill.Saver
import app.biopass.autofill.Target
import app.biopass.autofill.appLabel
import app.biopass.button
import app.biopass.card
import app.biopass.col
import app.biopass.dp
import app.biopass.errorMessage
import app.biopass.fadeIn
import app.biopass.label
import app.biopass.logo
import app.biopass.lp
import app.biopass.text
import app.biopass.vbox
import app.biopass.core.ApiError
import app.biopass.core.Change
import app.biopass.core.Domains
import app.biopass.core.Item
import app.biopass.core.Passkey
import app.biopass.core.WebAuthn
import org.json.JSONArray
import org.json.JSONObject

/**
 * Exécute une demande choisie dans le sélecteur système : déverrouiller (puis lister), se connecter
 * avec une clé d'accès ou un mot de passe, créer une clé d'accès, enregistrer un mot de passe.
 * Chaque utilisation d'un secret demande l'empreinte (ou le code du téléphone), sauf juste après un
 * déverrouillage. Fenêtre transparente : seul le dialogue d'empreinte s'affiche, en général.
 */
@RequiresApi(34)
class PasskeyActivity : BaseActivity() {
    override val needsUnlock = false

    companion object {
        const val MODE = "mode"
        const val MODE_UNLOCK = "unlock"
        const val MODE_GET_PASSKEY = "getPasskey"
        const val MODE_GET_PASSWORD = "getPassword"
        const val MODE_CREATE_PASSKEY = "createPasskey"
        const val MODE_CREATE_PASSWORD = "createPassword"

        /** Dernière vérification de l'utilisateur (déverrouillage ou empreinte) : vaut pour 1 min. */
        @Volatile private var verifiedAt = -1_000_000L
    }

    private var mode = ""
    private var started = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)
        mode = intent.getStringExtra(MODE) ?: ""
        if (!Session.hasProfile) {
            Toast.makeText(this, "Configurez d'abord BioPass", Toast.LENGTH_LONG).show()
            return finish()
        }
        if (Session.unlocked) proceed() else showUnlock()
    }

    override fun onLocked() = showUnlock()

    private fun showUnlock() {
        val panel = UnlockPanel(this, allowSwitchAccount = false) {
            verifiedAt = SystemClock.elapsedRealtime()
            proceed()
        }
        panel.view.setBackgroundColor(col(R.color.bp_bg))
        setRoot(panel.view)
        panel.start()
    }

    private fun proceed() {
        if (started) return
        started = true
        try {
            when (mode) {
                MODE_UNLOCK -> unlocked()
                MODE_GET_PASSKEY -> getPasskey()
                MODE_GET_PASSWORD -> getPassword()
                MODE_CREATE_PASSKEY -> createPasskey()
                MODE_CREATE_PASSWORD -> createPassword()
                else -> finish()
            }
        } catch (e: Exception) { // demande illisible
            if (mode.startsWith("create")) failCreate(CreateCredentialUnknownException(e.message)) else failGet(GetCredentialUnknownException(e.message))
        }
    }

    // ------------------------------------------------------------------ réponses

    private fun failGet(e: GetCredentialException) {
        if (e !is GetCredentialCancellationException) e.errorMessage?.let { Toast.makeText(applicationContext, it, Toast.LENGTH_LONG).show() }
        setResult(RESULT_OK, Intent().also { PendingIntentHandler.setGetCredentialException(it, e) })
        finish()
    }

    private fun failCreate(e: CreateCredentialException) {
        if (e !is CreateCredentialCancellationException) e.errorMessage?.let { Toast.makeText(applicationContext, it, Toast.LENGTH_LONG).show() }
        setResult(RESULT_OK, Intent().also { PendingIntentHandler.setCreateCredentialException(it, e) })
        finish()
    }

    private fun done(fill: (Intent) -> Unit) {
        Session.touch()
        setResult(RESULT_OK, Intent().also(fill))
        finish()
    }

    /**
     * Vérification de l'utilisateur : empreinte, ou code / schéma du téléphone. [then] reçoit true si
     * elle a eu lieu (drapeau UV), false si le téléphone n'a aucun verrouillage d'écran.
     */
    private fun verifyUser(title: String, subtitle: String, onCancel: () -> Unit, then: (Boolean) -> Unit) {
        if (SystemClock.elapsedRealtime() - verifiedAt < 60_000) return then(true)
        val auth = BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        if (getSystemService(BiometricManager::class.java).canAuthenticate(auth) != BiometricManager.BIOMETRIC_SUCCESS) return then(false)
        BiometricPrompt.Builder(this)
            .setTitle(title)
            .setSubtitle(subtitle)
            .setAllowedAuthenticators(auth)
            .setConfirmationRequired(false)
            .build()
            .authenticate(CancellationSignal(), mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    verifiedAt = SystemClock.elapsedRealtime()
                    then(true)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence?) = onCancel()
            })
    }

    /** Écrit l'entrée en arrière-plan (connexion au serveur nécessaire). */
    private fun save(data: JSONObject, id: String?, then: (Result<List<String>>) -> Unit) {
        Session.run({
            val v = Session.vault
            if (v.api.token == null && !v.reconnect()) throw ApiError(0, "Hors ligne : connexion au serveur nécessaire pour enregistrer")
            v.save(listOf(Change.Put(data, id)))
        }, then)
    }

    private fun item(id: String?): Item? = id?.let { Session.vault.items[it] }

    // ------------------------------------------------------------------ déverrouillage

    private fun unlocked() {
        val req = PendingIntentHandler.retrieveBeginGetCredentialRequest(intent) ?: return finish()
        done { PendingIntentHandler.setBeginGetCredentialResponse(it, Entries.response(this, req)) }
    }

    // ------------------------------------------------------------------ connexion

    private fun getPasskey() {
        val req = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent) ?: return finish()
        val opt = req.credentialOptions.filterIsInstance<GetPublicKeyCredentialOption>().firstOrNull()
            ?: return failGet(GetCredentialUnknownException("Demande de clé d'accès invalide"))
        val json = JSONObject(opt.requestJson)
        val it = item(intent.getStringExtra(Entries.ITEM))
        val pk = it?.passkeys?.firstOrNull { p -> p.credentialId == intent.getStringExtra(Entries.CRED) }
            ?: return failGet(NoCredentialException("Clé d'accès introuvable"))
        val rpId = json.optString("rpId").ifEmpty { pk.rpId }
        if (!rpId.equals(pk.rpId, ignoreCase = true)) return failGet(NoCredentialException("Clé d'accès d'un autre site"))
        resolve(req.callingAppInfo, pk.rpId, { e -> failGet(GetPublicKeyCredentialDomException(NotAllowedError(), e)) }) { caller ->
            verifyUser("Se connecter à ${pk.rpId}", pk.userName.ifEmpty { it.username }, { failGet(GetCredentialCancellationException()) }) { uv ->
                if (!uv && json.optString("userVerification") == "required") {
                    return@verifyUser failGet(GetPublicKeyCredentialDomException(NotAllowedError(), "Activez un verrouillage d'écran sur le téléphone"))
                }
                val s = WebAuthn.assert(pk, json.getString("challenge"), caller.origin, caller.androidPackage, opt.clientDataHash, uv)
                if (s.counter > 0) save(withPasskey(it, pk.withCounter(s.counter)), it.id) {} // compteur importé : à faire progresser
                done { i -> PendingIntentHandler.setGetCredentialResponse(i, GetCredentialResponse(PublicKeyCredential(s.responseJson))) }
            }
        }
    }

    private fun getPassword() {
        val req = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent) ?: return finish()
        if (req.credentialOptions.none { it is GetPasswordOption }) return failGet(GetCredentialUnknownException("Demande de mot de passe invalide"))
        val info = req.callingAppInfo
        val it = item(intent.getStringExtra(Entries.ITEM))
        // même règle que la liste : l'entrée doit correspondre à la page ou à l'appli qui demande
        val allowed = it != null && it in Entries.passwordsFor(Callers.browserOrigin(this, info), info.packageName)
        if (it == null || !allowed) return failGet(NoCredentialException("Identifiant introuvable"))
        verifyUser("Se connecter avec BioPass", it.name, { failGet(GetCredentialCancellationException()) }) { _ ->
            done { i -> PendingIntentHandler.setGetCredentialResponse(i, GetCredentialResponse(PasswordCredential(it.username, it.password))) }
        }
    }

    // ------------------------------------------------------------------ création

    private fun createPasskey() {
        val req = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent) ?: return finish()
        val cr = req.callingRequest as? CreatePublicKeyCredentialRequest
            ?: return failCreate(CreateCredentialUnknownException("Demande de clé d'accès invalide"))
        val json = JSONObject(cr.requestJson)
        val rp = json.getJSONObject("rp")
        val user = json.getJSONObject("user")
        val origin = Callers.browserOrigin(this, req.callingAppInfo)
        val rpId = rp.optString("id").ifEmpty { origin?.let { android.net.Uri.parse(it).host } ?: "" }.lowercase()
        if (rpId.isEmpty()) return failCreate(CreateCredentialUnknownException("Site inconnu"))
        val algs = json.optJSONArray("pubKeyCredParams")?.let { a -> (0 until a.length()).map { a.optJSONObject(it)?.optInt("alg") } } ?: emptyList()
        if (algs.isNotEmpty() && -7 !in algs) {
            return failCreate(CreatePublicKeyCredentialDomException(NotSupportedError(), "Algorithme non pris en charge par BioPass"))
        }
        val exclude = json.optJSONArray("excludeCredentials")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it)?.optString("id") }.toSet() } ?: emptySet()
        if (exclude.isNotEmpty() && Entries.passkeysFor(rpId, exclude).isNotEmpty()) {
            return failCreate(CreatePublicKeyCredentialDomException(InvalidStateError(), "Cette clé d'accès est déjà dans BioPass"))
        }
        resolve(req.callingAppInfo, rpId, { e -> failCreate(CreatePublicKeyCredentialDomException(NotAllowedError(), e)) }) { caller ->
            val userName = user.optString("name")
            val candidates = Session.vault.list().filter {
                Domains.matchesUrl(it, "https://$rpId") || (!caller.browser && Domains.matchesApp(it, caller.pkg))
            }
            val create = { target: Item? ->
                verifyUser("Créer une clé d'accès", "$rpId · $userName", { failCreate(CreateCredentialCancellationException()) }) { uv ->
                    if (!uv && json.optJSONObject("authenticatorSelection")?.optString("userVerification") == "required") {
                        return@verifyUser failCreate(CreatePublicKeyCredentialDomException(NotAllowedError(), "Activez un verrouillage d'écran sur le téléphone"))
                    }
                    val c = WebAuthn.create(rpId, rp.optString("name"), user.getString("id"), userName, user.optString("displayName"),
                        json.getString("challenge"), caller.origin, caller.androidPackage, cr.clientDataHash, uv)
                    val data = if (target != null) withPasskey(target, c.passkey) else JSONObject()
                        .put("type", "login").put("name", rp.optString("name").ifEmpty { rpId }).put("username", userName)
                        .put("uris", JSONArray().put("https://$rpId").apply { if (!caller.browser) put(Domains.appUri(caller.pkg)) })
                        .put("passkeys", JSONArray().put(c.passkey.toJson()))
                    showBusy("Enregistrement de la clé d'accès…")
                    // la clé n'est rendue au site qu'une fois enregistrée : sinon elle serait perdue
                    save(data, target?.id) { r ->
                        r.onSuccess {
                            Toast.makeText(applicationContext, "Clé d'accès enregistrée dans BioPass", Toast.LENGTH_SHORT).show()
                            done { i -> PendingIntentHandler.setCreateCredentialResponse(i, CreatePublicKeyCredentialResponse(c.responseJson)) }
                        }.onFailure { e -> failCreate(CreateCredentialUnknownException("Clé d'accès non enregistrée : " + errorMessage(e))) }
                    }
                }
            }
            if (candidates.isEmpty()) create(null) else chooseEntry(rpId, userName, candidates, create)
        }
    }

    private fun createPassword() {
        val req = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent) ?: return finish()
        val cr = req.callingRequest as? CreatePasswordRequest ?: return failCreate(CreateCredentialUnknownException("Demande invalide"))
        val info = req.callingAppInfo
        val origin = Callers.browserOrigin(this, info)
        val target = origin?.let { o -> android.net.Uri.parse(o).host?.let { Target.Web(it) } } ?: Target.App(info.packageName)
        val label = if (target is Target.App) appLabel(this, info.packageName) else target.label(this)
        showBusy("Enregistrement…")
        Session.run({ Saver.save(PendingSave.Data(target, cr.id, cr.password), label) }) { r ->
            r.onSuccess { msg ->
                Toast.makeText(applicationContext, msg, Toast.LENGTH_SHORT).show()
                done { i -> PendingIntentHandler.setCreateCredentialResponse(i, CreatePasswordResponse()) }
            }.onFailure { e -> failCreate(CreateCredentialUnknownException("Non enregistré : " + errorMessage(e))) }
        }
    }

    // ------------------------------------------------------------------ outils

    /** Vérifie l'appelant (réseau possible) puis continue sur le thread UI. */
    private fun resolve(info: CallingAppInfo, rpId: String, fail: (String) -> Unit, then: (Caller) -> Unit) {
        Session.run({ Callers.resolve(this, info, rpId) }) { r ->
            r.onSuccess(then).onFailure { e -> fail(e.message ?: "Application non autorisée") }
        }
    }

    /** Copie de l'entrée avec [pk] (remplace la clé du même compte sur le même site). */
    private fun withPasskey(it: Item, pk: Passkey): JSONObject {
        val list = JSONArray()
        for (p in it.passkeys) {
            val same = p.credentialId == pk.credentialId || (p.rpId.equals(pk.rpId, ignoreCase = true) && p.userHandle == pk.userHandle)
            if (!same) list.put(p.toJson())
        }
        return it.copyData().put("passkeys", list.put(pk.toJson()))
    }

    /** Entrée qui recevra la nouvelle clé : celle du même identifiant par défaut, ou une nouvelle. */
    private fun chooseEntry(rpId: String, userName: String, items: List<Item>, then: (Item?) -> Unit) {
        val box = vbox(24, 24)
        box.addView(logo(64))
        box.addView(text("Enregistrer la clé d'accès", 22f, face = MEDIUM).apply { gravity = Gravity.CENTER }, lp(top = dp(16)))
        box.addView(text(if (userName.isNotEmpty()) "$rpId · $userName" else rpId, 15f, col(R.color.bp_text2)).apply { gravity = Gravity.CENTER },
            lp(top = dp(4), bottom = dp(16)))
        val c = card()
        c.addView(label("Ajouter à"), lp(bottom = dp(4)))
        val group = RadioGroup(this)
        val choices = items + listOf<Item?>(null)
        val preferred = items.indexOfFirst { it.username.equals(userName, ignoreCase = true) }.let { if (it < 0) choices.size - 1 else it }
        choices.forEachIndexed { i, it ->
            group.addView(RadioButton(this).apply {
                id = i + 1
                text = it?.let { e -> if (e.username.isNotEmpty()) "${e.name} · ${e.username}" else e.name } ?: "Nouvelle entrée"
                textSize = 16f
                setTextColor(col(R.color.bp_text))
                buttonTintList = android.content.res.ColorStateList.valueOf(col(R.color.bp_accent))
            }, lp(top = dp(2), bottom = dp(2)))
        }
        group.check(preferred + 1)
        c.addView(group)
        box.addView(c)
        box.addView(button("Enregistrer", BtnStyle.PRIMARY, R.drawable.ic_key) { then(choices[group.checkedRadioButtonId - 1]) }, lp(top = dp(16)))
        box.addView(button("Annuler", BtnStyle.TEXT) { failCreate(CreateCredentialCancellationException()) }, lp(top = dp(8)))
        val scroll = ScrollView(this).apply {
            isFillViewport = true
            setBackgroundColor(col(R.color.bp_bg))
            addView(box, FrameLayout.LayoutParams(MATCH, WRAP))
        }
        setRoot(scroll)
        box.fadeIn(dp(12))
    }

    private fun showBusy(msg: String) {
        val box = vbox(28, 24).apply { gravity = Gravity.CENTER }
        box.addView(logo(72))
        box.addView(text(msg, 18f, face = MEDIUM).apply { gravity = Gravity.CENTER }, lp(top = dp(20)))
        val root = FrameLayout(this).apply { setBackgroundColor(col(R.color.bp_bg)) }
        root.addView(box, FrameLayout.LayoutParams(MATCH, MATCH))
        setRoot(root)
    }
}
