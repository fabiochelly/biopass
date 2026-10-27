package app.biopass

import android.app.AlertDialog
import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import app.biopass.core.ApiError

/** Logo BioPass dans un halo arrondi. */
fun BaseActivity.logo(sizeDp: Int = 96): View = FrameLayout(this).apply {
    background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(col(R.color.bp_accent_soft))
    }
    addView(ImageView(this@logo).apply { setImageResource(R.drawable.ic_logo) },
        FrameLayout.LayoutParams(dp(sizeDp * 0.58f), dp(sizeDp * 0.58f), Gravity.CENTER))
    layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp)).apply { gravity = Gravity.CENTER_HORIZONTAL }
}

/**
 * Écran de déverrouillage (mot de passe maître ou empreinte), utilisé par l'app et par la
 * saisie automatique. Le travail lent (PBKDF2 600 000 itérations, réseau) est fait en arrière-plan.
 */
class UnlockPanel(
    private val act: BaseActivity,
    private val allowSwitchAccount: Boolean,
    private val onUnlocked: () -> Unit,
) {
    private val pw = act.input("Mot de passe maître", type = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
    private val error = act.text("", 14f, act.col(R.color.bp_danger)).apply { visibility = View.GONE; gravity = Gravity.CENTER }
    private val status = act.text("", 14f, act.col(R.color.bp_text2)).apply { gravity = Gravity.CENTER }
    private val progress = ProgressBar(act).apply { indeterminateTintList = ColorStateList.valueOf(act.col(R.color.bp_accent)) }
    private val busyBox = act.vbox().apply {
        gravity = Gravity.CENTER_HORIZONTAL
        addView(progress, LinearLayout.LayoutParams(act.dp(36), act.dp(36)))
        addView(status, lp(top = act.dp(8)))
        visibility = View.GONE
    }
    private val unlockBtn = act.button("Déverrouiller", BtnStyle.PRIMARY, R.drawable.ic_lock) { unlockPassword() }
    private val bioBtn = act.button("Utiliser l'empreinte", BtnStyle.TONAL, R.drawable.ic_fingerprint) { unlockBio() }
    private var busy = false

    val view: View = ScrollView(act).apply {
        isFillViewport = true
        val box = act.vbox(28, 24).apply { gravity = Gravity.CENTER }
        box.addView(act.logo())
        box.addView(act.text("BioPass", 30f, face = MEDIUM).apply { gravity = Gravity.CENTER }, lp(top = act.dp(20)))
        val p = Session.vault.profile
        val host = p?.server?.let { Uri.parse(app.biopass.core.Server.display(it)).host ?: "" } ?: "" // jamais la clé
        box.addView(act.text(if (p != null) "${p.user} · $host" else "", 14f, act.col(R.color.bp_text2)).apply { gravity = Gravity.CENTER },
            lp(top = act.dp(4), bottom = act.dp(36)))
        val eye = act.iconButton(R.drawable.ic_eye, "Afficher", act.col(R.color.bp_text2)) { v -> toggle(v as android.widget.ImageButton) }
        box.addView(act.inputWithActions(pw, eye), lp())
        box.addView(error, lp(top = act.dp(12)))
        box.addView(unlockBtn, lp(top = act.dp(20)))
        if (Bio.enabled) box.addView(bioBtn, lp(top = act.dp(12)))
        box.addView(busyBox, lp(top = act.dp(24)))
        if (allowSwitchAccount) {
            box.addView(act.button("Changer de compte", BtnStyle.TEXT) { switchAccount() }, lp(WRAP, WRAP, top = act.dp(28)).apply {
                gravity = Gravity.CENTER_HORIZONTAL
            })
        }
        addView(box, FrameLayout.LayoutParams(MATCH, WRAP))
        box.fadeIn(act.dp(12))
    }

    init {
        pw.imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_DONE
        pw.onDone { unlockPassword() }
    }

    /** À appeler une fois la vue affichée : lance l'empreinte si activée, sinon ouvre le clavier. */
    fun start() {
        if (Bio.enabled) view.post { unlockBio() } else pw.showKeyboard()
    }

    private fun toggle(b: android.widget.ImageButton) {
        val shown = pw.inputType and InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD != 0
        pw.inputType = InputType.TYPE_CLASS_TEXT or if (shown) InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        pw.typeface = android.graphics.Typeface.DEFAULT
        pw.setSelection(pw.text.length)
        b.setImageResource(if (shown) R.drawable.ic_eye else R.drawable.ic_eye_off)
    }

    private fun setBusy(on: Boolean, msg: String = "") {
        busy = on
        busyBox.visibility = if (on) View.VISIBLE else View.GONE
        status.text = msg
        unlockBtn.isEnabled = !on
        unlockBtn.alpha = if (on) 0.5f else 1f
        bioBtn.isEnabled = !on
        pw.isEnabled = !on
        if (on) error.visibility = View.GONE
    }

    private fun showError(msg: String) {
        error.text = msg
        error.visibility = View.VISIBLE
        error.fadeIn()
    }

    private fun unlockPassword() {
        if (busy) return
        val password = pw.text.toString()
        if (password.isEmpty()) return showError("Saisissez votre mot de passe maître")
        pw.hideKeyboard()
        setBusy(true, "Déverrouillage…")
        Session.run({ Session.vault.unlock(password) }) { r ->
            setBusy(false)
            r.onSuccess {
                pw.setText("")
                Session.onUnlocked()
                offerBio()
            }.onFailure { e ->
                showError(if (e is ApiError && e.status == 401) "Mot de passe incorrect" else errorMessage(e))
                pw.selectAll()
            }
        }
    }

    private fun unlockBio() {
        if (busy) return
        Bio.unlock(act) { secrets, msg ->
            if (secrets == null) {
                if (msg != null) showError(msg)
                if (!Bio.enabled) bioBtn.visibility = View.GONE
                pw.showKeyboard()
                return@unlock
            }
            setBusy(true, "Déverrouillage…")
            Session.run({ Session.vault.unlockWithKey(secrets.raw, secrets.auth) }) { r ->
                setBusy(false)
                r.onSuccess {
                    Session.onUnlocked()
                    onUnlocked()
                }.onFailure { e ->
                    if (e is ApiError && e.status == 401) {
                        Bio.disable()
                        bioBtn.visibility = View.GONE
                        showError("Le mot de passe maître a changé : saisissez-le (empreinte désactivée)")
                    } else {
                        showError(errorMessage(e))
                    }
                }
            }
        }
    }

    /** Après le premier déverrouillage par mot de passe : proposer l'empreinte (une fois). */
    private fun offerBio() {
        val prefs = Session.prefs
        if (Bio.enabled || prefs.getBoolean("bioAsked", false) || !Bio.available()) return onUnlocked()
        prefs.edit().putBoolean("bioAsked", true).apply()
        AlertDialog.Builder(act)
            .setTitle("Déverrouiller avec l'empreinte ?")
            .setMessage("Ouvrez BioPass et remplissez vos mots de passe d'un simple contact. Vous pourrez changer d'avis dans les paramètres.")
            .setPositiveButton("Activer") { _, _ ->
                Bio.enable(act) { err ->
                    if (err != null) act.toast(err)
                    onUnlocked()
                }
            }
            .setNegativeButton("Plus tard") { _, _ -> onUnlocked() }
            .setOnCancelListener { onUnlocked() }
            .show()
    }

    private fun switchAccount() {
        AlertDialog.Builder(act)
            .setTitle("Changer de compte ?")
            .setMessage("Le cache local de ce compte sera effacé de ce téléphone. Vos données restent sur le serveur.")
            .setPositiveButton("Changer") { _, _ ->
                Session.run({ Session.vault.forget(); Bio.disable(); Keep.clear() }) {
                    act.startActivity(android.content.Intent(act, SetupActivity::class.java))
                }
            }
            .setNegativeButton("Annuler", null)
            .show()
    }
}
