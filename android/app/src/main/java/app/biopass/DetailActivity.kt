package app.biopass

import android.app.AlertDialog
import android.content.Intent
import android.content.res.ColorStateList
import android.net.Uri
import android.os.Bundle
import android.text.format.DateFormat
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import app.biopass.core.Change
import app.biopass.core.Domains
import app.biopass.core.Item
import app.biopass.core.Totp
import java.util.Date

class DetailActivity : BaseActivity() {
    private lateinit var id: String
    private var totpTick: Runnable? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        id = intent.getStringExtra("id") ?: return finish()
    }

    override fun onResume() {
        super.onResume()
        if (!Session.unlocked) return
        val item = Session.vault.items[id] ?: return finish()
        render(item)
    }

    override fun onPause() {
        super.onPause()
        totpTick?.let { Session.main.removeCallbacks(it) }
    }

    private fun render(it: Item) {
        totpTick?.let { r -> Session.main.removeCallbacks(r) }
        val root = vbox()
        root.addView(topBar("", R.drawable.ic_back,
            iconButton(R.drawable.ic_edit, "Modifier") { startActivity(Intent(this, EditActivity::class.java).putExtra("id", id)) },
            iconButton(R.drawable.ic_delete, "Supprimer") { _ -> confirmDelete(it) }))

        val body = vbox(16, 0)
        // En-tête
        val head = vbox().apply { gravity = Gravity.CENTER_HORIZONTAL }
        head.addView(avatar(it.name.ifBlank { "?" }, 72).also { a -> bindItemAvatar(a, it) })
        head.addView(text(it.name.ifBlank { "(sans nom)" }, 24f, face = MEDIUM).apply { gravity = Gravity.CENTER }, lp(WRAP, WRAP, top = dp(12)))
        if (it.folder.isNotBlank()) {
            head.addView(text(it.folder, 13f, col(R.color.bp_on_accent_soft), MEDIUM).apply {
                background = rounded(col(R.color.bp_accent_soft), dp(12).toFloat())
                setPadding(dp(12), dp(4), dp(12), dp(4))
            }, lp(WRAP, WRAP, top = dp(8)))
        }
        body.addView(head, lp(bottom = dp(20), top = dp(4)))

        if (it.username.isNotEmpty()) body.addView(fieldCard("Identifiant", it.username))
        if (it.password.isNotEmpty()) body.addView(fieldCard("Mot de passe", it.password, hidden = true, mono = true))
        if (it.history.isNotEmpty()) body.addView(historyCard(it))
        if (it.totp.isNotBlank()) body.addView(totpCard(it.totp))
        val uris = it.uris.filter { u -> u.isNotBlank() }
        if (uris.isNotEmpty()) {
            val c = card()
            c.addView(label("Sites et applications"), lp(bottom = dp(4)))
            for (u in uris) {
                val row = hbox()
                row.addView(text(if (Domains.isAppUri(u)) "Appli · " + u.substringAfter("://") else u, 15f).apply {
                    isSingleLine = true; ellipsize = android.text.TextUtils.TruncateAt.END
                }, lp(0, WRAP, 1f))
                if (!Domains.isAppUri(u)) row.addView(iconButton(R.drawable.ic_open, "Ouvrir", col(R.color.bp_accent)) {
                    val url = if (u.contains("://")) u else "https://$u"
                    try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Exception) { toast("Impossible d'ouvrir le lien") }
                })
                c.addView(row, lp())
            }
            body.addView(c)
        }
        for (f in it.fields) body.addView(fieldCard(f.name.ifBlank { "Champ" }, f.value, hidden = f.hidden))
        if (it.notes.isNotBlank()) body.addView(fieldCard("Notes", it.notes, multiline = true))
        val updated = it.data.optLong("updated", 0)
        if (updated > 0) {
            body.addView(text("Modifiée le " + DateFormat.getMediumDateFormat(this).format(Date(updated)) + " à " +
                DateFormat.getTimeFormat(this).format(Date(updated)), 12f, col(R.color.bp_text2)).apply { gravity = Gravity.CENTER },
                lp(top = dp(8), bottom = dp(24)))
        }

        val scroll = ScrollView(this).apply { clipToPadding = false }
        scroll.addView(body, FrameLayout.LayoutParams(MATCH, WRAP))
        root.addView(scroll, lp(MATCH, 0, 1f))
        setRoot(root)
        body.fadeIn(dp(8))
    }

    private fun fieldCard(title: String, value: String, hidden: Boolean = false, mono: Boolean = false, multiline: Boolean = false): View {
        val c = card()
        val row = hbox()
        val texts = vbox()
        texts.addView(label(title))
        val v = text(if (hidden) mask(value) else value, if (multiline) 15f else 17f, face = if (mono || hidden) MONO else null).apply {
            if (!multiline) { isSingleLine = true; ellipsize = android.text.TextUtils.TruncateAt.END }
        }
        texts.addView(v, lp(top = dp(4), bottom = dp(4)))
        row.addView(texts, lp(0, WRAP, 1f))
        if (hidden) {
            var shown = false
            row.addView(iconButton(R.drawable.ic_eye, "Afficher", col(R.color.bp_text2)) { b ->
                shown = !shown
                v.text = if (shown) value else mask(value)
                v.isSingleLine = !shown
                (b as ImageButton).setImageResource(if (shown) R.drawable.ic_eye_off else R.drawable.ic_eye)
            })
        }
        row.addView(iconButton(R.drawable.ic_copy, "Copier", col(R.color.bp_accent)) { Session.copy(this, title, value) })
        c.addView(row)
        return c
    }

    /** Anciens mots de passe, repliés par défaut. */
    private fun historyCard(it: Item): View {
        val c = card()
        val list = vbox().apply { visibility = View.GONE }
        val head = text("Anciens mots de passe (${it.history.size})", 15f, col(R.color.bp_accent), MEDIUM).apply {
            minHeight = dp(36)
            gravity = Gravity.CENTER_VERTICAL
            setOnClickListener {
                list.visibility = if (list.visibility == View.GONE) View.VISIBLE else View.GONE
                if (list.visibility == View.VISIBLE) list.fadeIn(dp(4))
            }
        }
        c.addView(head)
        for (h in it.history) {
            val row = hbox()
            val texts = vbox()
            val v = text(mask(h.password), 15f, face = MONO).apply { isSingleLine = true; ellipsize = android.text.TextUtils.TruncateAt.END }
            texts.addView(v)
            if (h.date > 0) texts.addView(text("Remplacé le " + DateFormat.getMediumDateFormat(this).format(Date(h.date)), 12f, col(R.color.bp_text2)))
            row.addView(texts, lp(0, WRAP, 1f))
            var shown = false
            row.addView(iconButton(R.drawable.ic_eye, "Afficher", col(R.color.bp_text2)) { b ->
                shown = !shown
                v.text = if (shown) h.password else mask(h.password)
                (b as ImageButton).setImageResource(if (shown) R.drawable.ic_eye_off else R.drawable.ic_eye)
            })
            row.addView(iconButton(R.drawable.ic_copy, "Copier", col(R.color.bp_accent)) { Session.copy(this, "Ancien mot de passe", h.password) })
            list.addView(row, lp(top = dp(6)))
        }
        c.addView(list, lp(bottom = dp(6)))
        return c
    }

    private fun mask(s: String) = "•".repeat(s.length.coerceIn(8, 16))

    private fun totpCard(secret: String): View {
        val c = card()
        c.addView(label("Code à usage unique"))
        val row = hbox()
        val code = text("", 30f, col(R.color.bp_accent), MONO).apply { letterSpacing = 0.08f }
        row.addView(code, lp(0, WRAP, 1f))
        val secs = text("", 13f, col(R.color.bp_text2), MEDIUM)
        row.addView(secs, lp(WRAP, WRAP, end = dp(4)))
        row.addView(iconButton(R.drawable.ic_copy, "Copier", col(R.color.bp_accent)) {
            Totp.codeOrNull(secret)?.let { t -> Session.copy(this, "Code", t.code) }
        })
        c.addView(row, lp(top = dp(2)))
        val bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            progressTintList = ColorStateList.valueOf(col(R.color.bp_accent))
            progressBackgroundTintList = ColorStateList.valueOf(col(R.color.bp_surface2))
        }
        c.addView(bar, LinearLayout.LayoutParams(MATCH, dp(4)).apply { topMargin = dp(6); bottomMargin = dp(8) })
        val tick = object : Runnable {
            override fun run() {
                val t = Totp.codeOrNull(secret)
                if (t == null) {
                    code.text = "Secret invalide"; code.textSize = 16f; bar.visibility = View.GONE
                    return
                }
                code.text = if (t.code.length == 6) t.code.substring(0, 3) + " " + t.code.substring(3) else t.code
                secs.text = "${t.remaining} s"
                bar.max = t.period
                bar.progress = t.remaining
                code.setTextColor(col(if (t.remaining <= 5) R.color.bp_danger else R.color.bp_accent))
                Session.main.postDelayed(this, 1000 - System.currentTimeMillis() % 1000)
            }
        }
        totpTick = tick
        tick.run()
        return c
    }

    private fun confirmDelete(it: Item) {
        AlertDialog.Builder(this)
            .setTitle("Supprimer « ${it.name} » ?")
            .setMessage("L'entrée sera supprimée sur tous vos appareils.")
            .setPositiveButton("Supprimer") { _, _ ->
                Session.run({ Session.vault.save(listOf(Change.Delete(id))) }) { r ->
                    r.onSuccess { finish() }.onFailure { e -> handleError(e) }
                }
            }
            .setNegativeButton("Annuler", null)
            .show()
    }
}

