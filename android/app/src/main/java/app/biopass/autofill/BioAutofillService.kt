package app.biopass.autofill

import android.content.Intent
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.SaveCallback
import android.service.autofill.SaveRequest
import app.biopass.Session
import app.biopass.errorMessage

/**
 * Service de saisie automatique BioPass. Aucun secret n'est journalisé ; le remplissage
 * n'a lieu que lorsque l'utilisateur choisit une suggestion (modèle Android).
 */
class BioAutofillService : AutofillService() {
    private fun toast(ctx: android.content.Context, msg: String) = android.widget.Toast.makeText(ctx, msg, android.widget.Toast.LENGTH_LONG).show()

    override fun onCreate() {
        super.onCreate()
        Session.init(this)
    }

    override fun onFillRequest(request: FillRequest, cancellationSignal: CancellationSignal, callback: FillCallback) {
        try {
            val structure = request.fillContexts.lastOrNull()?.structure ?: return callback.onSuccess(null)
            val p = Parser.parse(structure)
            if (p.form.isEmpty || p.pkg == packageName || p.pkg in IGNORED_PACKAGES || !Session.hasProfile) return callback.onSuccess(null)
            val inline = if (android.os.Build.VERSION.SDK_INT >= 30) request.inlineSuggestionsRequest else null
            Responses.lastInline = inline
            callback.onSuccess(Responses.build(this, p, inline))
        } catch (e: Exception) {
            callback.onSuccess(null)
        }
    }

    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        try {
            var target: Target? = null
            var user: String? = null
            var pw: String? = null
            // Contexte le plus récent d'abord (formulaires en plusieurs étapes : identifiant puis mot de passe).
            for (ctx in request.fillContexts.reversed()) {
                val p = Parser.parse(ctx.structure)
                if (p.pkg == packageName || p.pkg in IGNORED_PACKAGES) return callback.onFailure(null)
                if (pw == null) p.passwordValue?.let { pw = it; target = p.target }
                if (user == null) user = p.usernameValue
                if (target == null && p.target !is Target.Unknown) target = p.target
            }
            val password = pw ?: return callback.onFailure("Aucun mot de passe à enregistrer")
            val data = PendingSave.Data(target ?: Target.Unknown, user, password)
            val app = applicationContext
            if (Session.unlocked) {
                // Déverrouillé : enregistrement direct, sans activité (lancement souvent bloqué sur Android 14+).
                callback.onSuccess()
                val label = data.target.label(this)
                Session.run({ Saver.save(data, label) }) { r ->
                    r.onSuccess { toast(app, it) }.onFailure { e ->
                        PendingSave.put(data)
                        toast(app, "BioPass : non enregistré (" + errorMessage(e) + "). Ouvrez BioPass pour réessayer.")
                    }
                }
                return
            }
            // Verrouillé : activité de déverrouillage. Si Android bloque son lancement, la demande
            // reste en attente et sera proposée à la prochaine ouverture de BioPass.
            val token = PendingSave.put(data)
            callback.onSuccess(Responses.sender(this, Responses.MODE_SAVE) { i: Intent -> i.putExtra("token", token) })
            Session.main.postDelayed({
                if (PendingSave.has(token) && !AutofillActivity.visible) {
                    toast(app, "BioPass est verrouillé : ouvrez BioPass pour enregistrer cet identifiant")
                }
            }, 2500)
        } catch (e: Exception) {
            callback.onFailure("BioPass : enregistrement impossible")
        }
    }
}
