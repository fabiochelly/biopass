package app.biopass

import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.autofill.AutofillManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView

class SettingsActivity : BaseActivity() {
    override val needsUnlock = false

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun render() {
        val root = vbox()
        root.addView(topBar("Paramètres"))
        val body = vbox(16, 4)
        val v = Session.vault
        val p = v.profile

        // Compte
        if (p != null) {
            val c = card()
            c.addView(label("Compte"))
            c.addView(text(p.user, 18f, face = MEDIUM), lp(top = dp(4)))
            c.addView(text(app.biopass.core.Server.display(p.server), 14f, col(R.color.bp_text2))) // jamais la clé
            val state = when {
                !Session.unlocked -> "Verrouillé"
                v.online -> "Déverrouillé · en ligne"
                else -> "Déverrouillé · hors ligne (lecture seule)"
            }
            c.addView(text(state, 14f, col(R.color.bp_accent), MEDIUM), lp(top = dp(6), bottom = dp(4)))
            body.addView(c)
        }

        // Saisie automatique
        val af = card()
        af.addView(label("Saisie automatique"))
        val enabled = getSystemService(AutofillManager::class.java)?.hasEnabledAutofillServices() == true
        af.addView(text(if (enabled) "BioPass est votre service de saisie automatique." else "BioPass n'est pas encore votre service de saisie automatique.",
            15f), lp(top = dp(4)))
        if (!enabled) {
            af.addView(button("Choisir BioPass", BtnStyle.PRIMARY) {
                try {
                    startActivity(Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE).setData(Uri.parse("package:$packageName")))
                } catch (e: Exception) {
                    toast("Ouvrez Paramètres → Mots de passe et comptes → Service de saisie automatique")
                }
            }, lp(top = dp(12)))
        }
        af.addView(text("Chrome et Brave : dans leurs paramètres, section « Saisie automatique », choisissez « Saisie automatique via un autre service ».",
            13f, col(R.color.bp_text2)), lp(top = dp(10), bottom = dp(6)))
        body.addView(af)

        // Empreinte
        if (Bio.available() || Bio.enabled) {
            val bio = card()
            val sw = Switch(this).apply {
                text = "Déverrouiller avec l'empreinte"
                textSize = 16f
                setTextColor(col(R.color.bp_text))
                isChecked = Bio.enabled
            }
            sw.setOnCheckedChangeListener { b, on ->
                if (on == Bio.enabled) return@setOnCheckedChangeListener
                if (!on) {
                    Bio.disable()
                    return@setOnCheckedChangeListener
                }
                if (!Session.unlocked) {
                    toast("Déverrouillez d'abord le coffre avec le mot de passe")
                    b.isChecked = false
                    return@setOnCheckedChangeListener
                }
                Bio.enable(this) { err ->
                    if (err != null) toast(err)
                    render()
                }
            }
            bio.addView(sw, lp(top = dp(4), bottom = dp(4)))
            bio.addView(text("La clé du coffre est protégée par le Keystore du téléphone ; elle est effacée si une nouvelle empreinte est enregistrée.",
                13f, col(R.color.bp_text2)), lp(bottom = dp(6)))
            body.addView(bio)
        }

        // Verrouillage automatique
        val lock = card()
        lock.addView(label("Verrouillage automatique après inactivité"))
        val chips = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val options = listOf(1 to "1 min", 5 to "5 min", 15 to "15 min", 60 to "1 h", 0 to "Jamais")
        val views = ArrayList<TextView>()
        fun paint() {
            for ((i, t) in views.withIndex()) {
                val sel = options[i].first == Session.lockMinutes
                t.background = ripple(if (sel) rounded(col(R.color.bp_accent), dp(16).toFloat())
                else rounded(col(R.color.bp_surface2), dp(16).toFloat()), 16)
                t.setTextColor(col(if (sel) R.color.bp_on_accent else R.color.bp_text))
            }
        }
        for ((min, lbl) in options) {
            val t = text(lbl, 14f, face = MEDIUM).apply {
                gravity = Gravity.CENTER
                minHeight = dp(36)
                setPadding(dp(4), 0, dp(4), 0)
                setOnClickListener {
                    Session.lockMinutes = min
                    if (Session.vault.unlocked) Session.touch()
                    paint()
                }
            }
            views.add(t)
            chips.addView(t, lp(0, WRAP, 1f, end = dp(6)))
        }
        val warn = text("Le coffre reste ouvert sur ce téléphone, même après un redémarrage ; protégez l'appareil par un code de verrouillage.",
            13f, col(R.color.bp_warn_text)).apply {
            background = rounded(col(R.color.bp_warn_bg), dp(12).toFloat())
            setPadding(dp(12), dp(8), dp(12), dp(8))
        }
        val paintAll = { paint(); warn.visibility = if (Session.lockMinutes == 0) android.view.View.VISIBLE else android.view.View.GONE }
        for ((i, t) in views.withIndex()) t.setOnClickListener {
            Session.lockMinutes = options[i].first
            if (Session.vault.unlocked) Session.touch()
            paintAll()
        }
        paintAll()
        lock.addView(chips, lp(top = dp(10), bottom = dp(10)))
        lock.addView(warn, lp(bottom = dp(10)))
        body.addView(lock)

        if (Session.unlocked) {
            body.addView(button("Verrouiller maintenant", BtnStyle.TONAL, R.drawable.ic_lock) {
                Session.lock()
                finish()
            }, lp(top = dp(6)))
        }
        if (p != null) {
            body.addView(button("Changer de compte", BtnStyle.DANGER) {
                AlertDialog.Builder(this)
                    .setTitle("Changer de compte ?")
                    .setMessage("Le cache local de ce compte sera effacé de ce téléphone. Vos données restent sur le serveur.")
                    .setPositiveButton("Changer") { _, _ ->
                        Session.run({ Session.vault.forget(); Bio.disable(); Keep.clear() }) {
                            startActivity(Intent(this, SetupActivity::class.java))
                            finish()
                        }
                    }
                    .setNegativeButton("Annuler", null)
                    .show()
            }, lp(top = dp(10)))
        }
        val version = try { packageManager.getPackageInfo(packageName, 0).versionName } catch (e: Exception) { "" }
        body.addView(text("BioPass $version", 12f, col(R.color.bp_text2)).apply { gravity = Gravity.CENTER }, lp(top = dp(20), bottom = dp(24)))

        val scroll = ScrollView(this)
        scroll.addView(body, FrameLayout.LayoutParams(MATCH, WRAP))
        root.addView(scroll, lp(MATCH, 0, 1f))
        setRoot(root)
    }
}
