package app.biopass

import android.content.res.ColorStateList
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import app.biopass.core.Server

/** Première configuration : adresse du serveur, identifiant, mot de passe maître. */
class SetupActivity : BaseActivity() {
    override val needsUnlock = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prev = Session.vault.profile
        // Adresse mémorisée (forme normalisée, clé incluse) : seule la base est affichée.
        val stored = prev?.server ?: Session.prefs.getString("lastServer", "") ?: ""
        val server = input("https://coffre.exemple.fr/?k=…", Server.display(stored),
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        val user = input("prenom", prev?.user ?: "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
        val pw = input("••••••••", type = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        pw.imeOptions = EditorInfo.IME_ACTION_GO
        val error = text("", 14f, col(R.color.bp_danger)).apply { visibility = View.GONE }
        val progress = ProgressBar(this).apply {
            indeterminateTintList = ColorStateList.valueOf(col(R.color.bp_accent))
            visibility = View.GONE
        }

        lateinit var go: View
        fun connect() {
            var s = server.text.toString().trim()
            val u = user.text.toString().trim().lowercase()
            val p = pw.text.toString()
            if (s.isEmpty() || u.isEmpty() || p.isEmpty()) {
                error.text = "Remplissez les trois champs"; error.visibility = View.VISIBLE; return
            }
            val parsed = try {
                Server.parse(s)
            } catch (e: IllegalArgumentException) {
                error.text = "Adresse du serveur invalide"; error.visibility = View.VISIBLE; return
            }
            // Base inchangée sans clé saisie : on reprend la clé mémorisée.
            s = if (parsed.key.isEmpty() && stored.isNotEmpty() && Server.display(stored) == parsed.base) stored else Server.norm(s)
            if (parsed.base.startsWith("http://") && !Regex("^http://(localhost|127\\.0\\.0\\.1)([:/]|$)").containsMatchIn(parsed.base)) {
                error.text = "Utilisez une adresse https:// (connexion chiffrée obligatoire)"; error.visibility = View.VISIBLE; return
            }
            pw.hideKeyboard()
            error.visibility = View.GONE
            progress.visibility = View.VISIBLE
            go.isEnabled = false
            go.alpha = 0.5f
            Session.run({ Session.vault.login(s, u, p) }) { r ->
                progress.visibility = View.GONE
                go.isEnabled = true
                go.alpha = 1f
                r.onSuccess {
                    Session.prefs.edit().putString("lastServer", s).putBoolean("bioAsked", false).apply()
                    Bio.disable()
                    Session.onUnlocked()
                    finish()
                }.onFailure { e ->
                    error.text = errorMessage(e)
                    error.visibility = View.VISIBLE
                    error.fadeIn()
                }
            }
        }
        pw.onDone { connect() }
        go = button("Se connecter", BtnStyle.PRIMARY) { connect() }

        val box = vbox(24, 24).apply { gravity = Gravity.CENTER_VERTICAL }
        box.addView(logo(80))
        box.addView(text("Bienvenue", 28f, face = MEDIUM).apply { gravity = Gravity.CENTER }, lp(top = dp(16)))
        box.addView(text("Connectez BioPass à votre serveur familial.\nLe compte se crée depuis le site web.", 15f, col(R.color.bp_text2)).apply {
            gravity = Gravity.CENTER
        }, lp(top = dp(6), bottom = dp(28)))
        val card = card(20)
        card.addView(labeled("Adresse du serveur", server))
        card.addView(labeled("Identifiant", user))
        card.addView(labeled("Mot de passe maître", pw))
        box.addView(card)
        box.addView(error, lp(top = dp(4), start = dp(4)))
        box.addView(go, lp(top = dp(16)))
        box.addView(progress, LinearLayout.LayoutParams(dp(36), dp(36)).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(16) })
        val scroll = ScrollView(this).apply { isFillViewport = true }
        scroll.addView(box, FrameLayout.LayoutParams(MATCH, WRAP))
        setRoot(scroll)
        box.fadeIn(dp(12))
    }

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        // Sans compte, il n'y a rien derrière : on quitte l'app.
        if (Session.hasProfile) super.onBackPressed() else finishAffinity()
    }
}
