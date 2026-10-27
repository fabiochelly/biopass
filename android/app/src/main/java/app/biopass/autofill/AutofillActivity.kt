package app.biopass.autofill

import android.app.AlertDialog
import android.app.assist.AssistStructure
import android.content.Intent
import android.content.res.ColorStateList
import android.os.Build
import android.os.Bundle
import android.os.Parcelable
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.autofill.AutofillManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.Toast
import app.biopass.BaseActivity
import app.biopass.BtnStyle
import app.biopass.ItemAdapter
import app.biopass.MATCH
import app.biopass.MEDIUM
import app.biopass.MainActivity
import app.biopass.R
import app.biopass.Session
import app.biopass.UnlockPanel
import app.biopass.WRAP
import app.biopass.button
import app.biopass.card
import app.biopass.col
import app.biopass.dp
import app.biopass.errorMessage
import app.biopass.fadeIn
import app.biopass.hbox
import app.biopass.iconButton
import app.biopass.logo
import app.biopass.lp
import app.biopass.onChange
import app.biopass.rounded
import app.biopass.showKeyboard
import app.biopass.text
import app.biopass.vbox
import app.biopass.core.ApiError
import app.biopass.core.Change
import app.biopass.core.Item
import app.biopass.core.Search
import org.json.JSONArray

/**
 * Activité lancée par la saisie automatique :
 *  - auth : déverrouiller puis renvoyer les suggestions (FillResponse) ;
 *  - pick : rechercher une entrée à la main et renvoyer ses valeurs (Dataset) ;
 *  - save : enregistrer / mettre à jour l'identifiant saisi.
 */
class AutofillActivity : BaseActivity() {
    override val needsUnlock = false

    private var mode = ""
    private var parsed: Parsed? = null
    private var pending: PendingSave.Data? = null
    private var started = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)
        mode = intent.getStringExtra(Responses.MODE) ?: ""
        val structure: AssistStructure? = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(AutofillManager.EXTRA_ASSIST_STRUCTURE, AssistStructure::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra<Parcelable>(AutofillManager.EXTRA_ASSIST_STRUCTURE) as? AssistStructure
        }
        parsed = structure?.let { runCatching { Parser.parse(it) }.getOrNull() }
        if (mode == Responses.MODE_SAVE) pending = PendingSave.take(intent.getStringExtra("token"))
        val ok = when (mode) {
            Responses.MODE_AUTH, Responses.MODE_PICK -> parsed != null
            Responses.MODE_SAVE -> pending != null
            else -> false
        }
        if (!ok) return finish()
        if (!Session.hasProfile) {
            Toast.makeText(this, "Configurez d'abord BioPass", Toast.LENGTH_LONG).show()
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return finish()
        }
        if (Session.unlocked) proceed() else showUnlock()
    }

    override fun onLocked() = showUnlock()

    override fun onResume() {
        super.onResume()
        visible = true
    }

    override fun onPause() {
        super.onPause()
        visible = false
    }

    companion object {
        /** Vrai tant que l'activité est au premier plan (le service n'affiche alors pas de toast). */
        @Volatile var visible = false
    }

    private fun showUnlock() {
        val panel = UnlockPanel(this, allowSwitchAccount = false) { proceed() }
        setRoot(panel.view)
        panel.start()
    }

    private fun proceed() {
        if (started) return
        started = true
        when (mode) {
            Responses.MODE_AUTH -> {
                val p = parsed!!
                setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, Responses.build(this, p)))
                finish()
            }
            Responses.MODE_PICK -> showPicker(parsed!!)
            Responses.MODE_SAVE -> save(pending!!)
        }
    }

    // ------------------------------------------------------------------ recherche manuelle

    private fun showPicker(p: Parsed) {
        val root = vbox()
        root.addView(topBar("Choisir une entrée", R.drawable.ic_close))
        if (p.target !is Target.Unknown) {
            root.addView(text("Pour " + p.target.label(this), 14f, col(R.color.bp_text2)), lp(start = dp(20), bottom = dp(4)))
        }
        val bar = hbox().apply {
            background = rounded(col(R.color.bp_surface), dp(26).toFloat())
            setPadding(dp(16), 0, dp(4), 0)
            minimumHeight = dp(52)
        }
        bar.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_search)
            imageTintList = ColorStateList.valueOf(col(R.color.bp_text2))
        }, LinearLayout.LayoutParams(dp(22), dp(22)))
        val q = EditText(this).apply {
            hint = "Rechercher"
            background = null
            isSingleLine = true
            textSize = 16f
            setTextColor(col(R.color.bp_text))
            setHintTextColor(col(R.color.bp_text2))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        bar.addView(q, lp(0, WRAP, 1f, start = dp(10)))
        root.addView(bar, lp(start = dp(16), end = dp(16), top = dp(4), bottom = dp(8)))

        val ad = ItemAdapter(this)
        val live = app.biopass.LiveSearch { ad.items = it }
        fun refresh(query: String, delayMs: Long) {
            val all = Session.vault.list()
            live.submit(delayMs) {
                if (query.isBlank()) {
                    val m = Responses.matching(p.target)
                    val ids = m.map { it.id }.toSet()
                    m + Search.search(all.filter { it.id !in ids }, "")
                } else Search.search(all, query)
            }
        }
        q.onChange { refresh(it, 30) }
        refresh("", 0)
        val list = ListView(this).apply {
            adapter = ad
            divider = null
            selector = android.graphics.drawable.ColorDrawable(0)
            clipToPadding = false
            setOnItemClickListener { _, _, pos, _ -> pick(p, ad.items[pos]) }
        }
        root.addView(list, lp(MATCH, 0, 1f))
        setRoot(root)
        root.fadeIn(dp(8))
        q.showKeyboard()
    }

    private fun pick(p: Parsed, item: Item) {
        val uri = p.target.uri
        if (uri == null || p.target.matches(item)) return fill(p, item)
        AlertDialog.Builder(this)
            .setTitle("Associer à ${p.target.label(this)} ?")
            .setMessage("« ${item.name} » sera proposé directement la prochaine fois.\n\n$uri")
            .setPositiveButton("Associer") { _, _ ->
                val data = item.copyData()
                val uris = data.optJSONArray("uris") ?: JSONArray()
                data.put("uris", uris.put(uri))
                val app = applicationContext
                // En arrière-plan : le remplissage n'attend pas le réseau.
                Session.run({
                    val v = Session.vault
                    if (v.api.token == null && !v.reconnect()) throw ApiError(0, "Hors ligne")
                    v.save(listOf(Change.Put(data, item.id)))
                }) { r ->
                    val msg = if (r.isSuccess) "Associé : ${item.name}" else "Association non enregistrée : " + errorMessage(r.exceptionOrNull()!!)
                    Toast.makeText(app, msg, Toast.LENGTH_SHORT).show()
                }
                fill(p, item)
            }
            .setNegativeButton("Non merci") { _, _ -> fill(p, item) }
            .show()
    }

    private fun fill(p: Parsed, item: Item) {
        val ds = Responses.dataset(this, p, item)
        if (ds == null) {
            toast("Cette entrée n'a rien à remplir ici")
            return
        }
        setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, ds))
        finish()
    }

    // ------------------------------------------------------------------ enregistrement

    private fun save(d: PendingSave.Data) {
        val box = vbox(28, 24).apply { gravity = Gravity.CENTER }
        box.addView(logo(80))
        val title = text("Enregistrement…", 22f, face = MEDIUM).apply { gravity = Gravity.CENTER }
        box.addView(title, lp(top = dp(20)))
        val progress = ProgressBar(this).apply { indeterminateTintList = ColorStateList.valueOf(col(R.color.bp_accent)) }
        box.addView(progress, LinearLayout.LayoutParams(dp(36), dp(36)).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(16) })
        val root = FrameLayout(this)
        root.addView(box, FrameLayout.LayoutParams(MATCH, MATCH))
        setRoot(root)

        val label = d.target.label(this)
        Session.run({ Saver.save(d, label) }) { r ->
            r.onSuccess { msg ->
                Toast.makeText(applicationContext, msg, Toast.LENGTH_SHORT).show()
                finish()
            }.onFailure { e ->
                progress.visibility = View.GONE
                title.text = "Non enregistré"
                val c = card()
                c.addView(text(errorMessage(e), 15f))
                c.addView(text("Copiez le mot de passe pour ne pas le perdre, puis ajoutez-le plus tard dans BioPass.", 14f, col(R.color.bp_text2)),
                    lp(top = dp(6), bottom = dp(6)))
                box.addView(c, lp(top = dp(20)))
                box.addView(button("Copier le mot de passe", BtnStyle.PRIMARY, R.drawable.ic_copy) { Session.copy(this, "Mot de passe", d.password) }, lp(top = dp(8)))
                box.addView(button("Fermer", BtnStyle.TEXT) { finish() }, lp(top = dp(8)))
                box.fadeIn(dp(8))
            }
        }
    }
}
