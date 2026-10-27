package app.biopass

import android.app.AlertDialog
import android.os.Bundle
import android.text.InputType
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ScrollView
import android.widget.Switch
import app.biopass.core.ApiError
import app.biopass.core.Change
import app.biopass.core.Domains
import app.biopass.core.PasswordGen
import app.biopass.core.Totp
import app.biopass.core.withHistory
import app.biopass.core.dropIconIfUrisChanged
import org.json.JSONArray
import org.json.JSONObject

/** Création / modification d'une entrée. Les champs non affichés du JSON sont conservés tels quels. */
class EditActivity : BaseActivity() {
    private var id: String? = null
    private lateinit var data: JSONObject
    private var saving = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        id = intent.getStringExtra("id")
        if (!Session.unlocked) return finish()
        val item = id?.let { Session.vault.items[it] }
        if (id != null && item == null) return finish()
        data = item?.copyData() ?: JSONObject().put("type", "login")

        val name = input("Ex. : Banque, GitHub…", item?.name ?: "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES)
        val user = input("Identifiant ou e-mail", item?.username ?: "",
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
        val pwType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        val pwVisible = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        val pw = input("Mot de passe", item?.password ?: "", pwType)
        val eye = iconButton(R.drawable.ic_eye, "Afficher", col(R.color.bp_text2)) { b ->
            val shown = pw.inputType == pwVisible
            pw.inputType = if (shown) pwType else pwVisible
            pw.typeface = if (shown) android.graphics.Typeface.DEFAULT else MONO
            pw.setSelection(pw.text.length)
            (b as ImageButton).setImageResource(if (shown) R.drawable.ic_eye else R.drawable.ic_eye_off)
        }
        val gen = iconButton(R.drawable.ic_generate, "Générer un mot de passe", col(R.color.bp_accent)) {
            pw.inputType = pwVisible
            pw.typeface = MONO
            eye.setImageResource(R.drawable.ic_eye_off)
            pw.setText(PasswordGen.generate())
            pw.setSelection(pw.text.length)
        }
        val uris = input("https://exemple.fr\nandroidapp://com.exemple", item?.uris?.joinToString("\n") ?: "",
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_MULTI_LINE, lines = 2)
        val totp = input("Secret base32 ou otpauth://…", item?.totp ?: "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
        val folder = input("Aucun", item?.folder ?: "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES)
        val notes = input("", item?.notes ?: "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES, lines = 3)
        val fav = Switch(this).apply {
            text = "Favori (en tête de liste)"
            textSize = 16f
            setTextColor(col(R.color.bp_text))
            isChecked = item?.fav ?: false
        }

        fun save() {
            if (saving) return
            val n = name.text.toString().trim()
            val u = user.text.toString().trim()
            val uriList = uris.text.toString().split('\n').map { it.trim() }.filter { it.isNotEmpty() }
            val t = totp.text.toString().trim()
            if (t.isNotEmpty() && Totp.codeOrNull(t) == null) return toast("Secret TOTP invalide")
            val finalName = n.ifEmpty { uriList.firstOrNull()?.let { Domains.baseDomain(Domains.hostOf(it)) }.orEmpty().ifEmpty { u } }
            if (finalName.isEmpty()) return toast("Donnez un nom à l'entrée")
            data.put("name", finalName)
            data.put("username", u)
            data.put("password", pw.text.toString())
            data.put("uris", JSONArray(uriList))
            data.put("totp", t)
            data.put("folder", folder.text.toString().trim())
            data.put("notes", notes.text.toString())
            data.put("fav", fav.isChecked)
            if (!data.has("type")) data.put("type", "login")
            saving = true
            val payload = dropIconIfUrisChanged(item?.uris ?: emptyList(), withHistory(item, JSONObject(data.toString())))
            Session.run({
                val v = Session.vault
                if (v.api.token == null && !v.reconnect()) throw ApiError(0, "Hors ligne : modification impossible")
                v.save(listOf(Change.Put(payload, id)))
            }) { r ->
                saving = false
                r.onSuccess { finish() }.onFailure { e -> handleError(e) }
            }
        }

        val root = vbox()
        val saveBtn = button("Enregistrer", BtnStyle.PRIMARY) { save() }.apply { minHeight = dp(40); setPadding(dp(18), 0, dp(18), 0) }
        root.addView(topBar(if (item == null) "Nouvelle entrée" else "Modifier", R.drawable.ic_close, saveBtn))
        saveBtn.layoutParams = lp(WRAP, dp(40))

        val body = vbox(16, 4)
        val main = card(16)
        main.addView(labeled("Nom", name))
        main.addView(labeled("Identifiant", user))
        main.addView(labeled("Mot de passe", inputWithActions(pw, eye, gen)))
        body.addView(main)
        val more = card(16)
        more.addView(labeled("Sites et applications (un par ligne)", uris))
        more.addView(labeled("Authentification à deux facteurs (TOTP)", totp))
        more.addView(labeled("Dossier", folder))
        more.addView(labeled("Notes", notes))
        more.addView(fav, lp(bottom = dp(12)))
        body.addView(more)
        if (item != null) {
            body.addView(button("Supprimer l'entrée", BtnStyle.DANGER, R.drawable.ic_delete) {
                AlertDialog.Builder(this)
                    .setTitle("Supprimer « ${item.name} » ?")
                    .setMessage("L'entrée sera supprimée sur tous vos appareils.")
                    .setPositiveButton("Supprimer") { _, _ ->
                        Session.run({ Session.vault.save(listOf(Change.Delete(item.id))) }) { r ->
                            r.onSuccess { finish() }.onFailure { e -> handleError(e) }
                        }
                    }
                    .setNegativeButton("Annuler", null)
                    .show()
            }, lp(top = dp(8), bottom = dp(24)))
        }
        val scroll = ScrollView(this)
        scroll.addView(body, FrameLayout.LayoutParams(MATCH, WRAP))
        root.addView(scroll, lp(MATCH, 0, 1f))
        setRoot(root)
        if (item == null) name.showKeyboard()
    }
}
