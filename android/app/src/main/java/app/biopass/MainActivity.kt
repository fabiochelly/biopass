package app.biopass

import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import app.biopass.core.Item
import app.biopass.core.Search

class MainActivity : BaseActivity() {
    override val needsUnlock = false

    private var showingList = false
    private var adapter: ItemAdapter? = null
    private var search: EditText? = null
    private var offline: TextView? = null
    private var empty: TextView? = null
    private var count: TextView? = null
    private var syncBtn: ImageButton? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
    }

    override fun onResume() {
        super.onResume()
        when {
            !Session.hasProfile -> {
                showingList = false
                startActivity(Intent(this, SetupActivity::class.java))
            }
            !Session.unlocked -> if (showingList || window.decorView.findViewWithTag<View>("unlock") == null) showUnlock()
            !showingList -> showList()
            else -> refresh()
        }
    }

    override fun onLocked() = showUnlock()

    private fun showUnlock() {
        showingList = false
        val panel = UnlockPanel(this, allowSwitchAccount = true) { showList() }
        panel.view.tag = "unlock"
        setRoot(panel.view)
        panel.start()
    }

    // ------------------------------------------------------------------ liste

    private fun showList() {
        showingList = true
        val root = FrameLayout(this)
        val content = vbox()

        // En-tête
        val header = hbox().apply { setPadding(dp(20), dp(12), dp(8), dp(4)) }
        val titles = vbox()
        titles.addView(text("Coffre", 30f, face = MEDIUM))
        count = text("", 13f, col(R.color.bp_text2))
        titles.addView(count)
        header.addView(titles, lp(0, WRAP, 1f))
        syncBtn = iconButton(R.drawable.ic_sync, "Synchroniser") { sync() }
        header.addView(syncBtn)
        header.addView(iconButton(R.drawable.ic_lock, "Verrouiller") {
            Session.lock()
            showUnlock()
        })
        header.addView(iconButton(R.drawable.ic_settings, "Paramètres") {
            startActivity(Intent(this, SettingsActivity::class.java))
        })
        content.addView(header)

        // Barre de recherche arrondie
        val bar = hbox().apply {
            background = rounded(col(R.color.bp_surface), dp(26).toFloat())
            elevation = dp(1).toFloat()
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
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH
        }
        search = q
        bar.addView(q, lp(0, WRAP, 1f, start = dp(10)))
        val clear = iconButton(R.drawable.ic_close, "Effacer", col(R.color.bp_text2)) { q.setText("") }.apply { visibility = View.GONE }
        bar.addView(clear)
        q.onChange {
            clear.visibility = if (it.isEmpty()) View.GONE else View.VISIBLE
            refresh(typing = true)
        }
        content.addView(bar, lp(start = dp(16), end = dp(16), top = dp(8), bottom = dp(8)))

        // Bandeau hors ligne
        offline = text("Hors ligne · lecture seule", 13f, col(R.color.bp_warn_text), MEDIUM).apply {
            background = rounded(col(R.color.bp_warn_bg), dp(12).toFloat())
            setPadding(dp(12), dp(8), dp(12), dp(8))
            setCompoundDrawablesRelativeWithIntrinsicBounds(getDrawable(R.drawable.ic_cloud_off)!!.mutate().apply {
                setTint(col(R.color.bp_warn_text)); setBounds(0, 0, dp(18), dp(18))
            }, null, null, null)
            compoundDrawablePadding = dp(8)
            gravity = Gravity.CENTER_VERTICAL
            visibility = View.GONE
            setOnClickListener { sync() }
        }
        content.addView(offline, lp(start = dp(16), end = dp(16), bottom = dp(4)))

        // Liste
        val listBox = FrameLayout(this)
        val ad = ItemAdapter(this, copyButtons = true)
        adapter = ad
        val list = ListView(this).apply {
            this.adapter = ad
            divider = null
            dividerHeight = 0
            selector = android.graphics.drawable.ColorDrawable(0)
            clipToPadding = false
            isVerticalScrollBarEnabled = false
            setOnItemClickListener { _, _, pos, _ ->
                startActivity(Intent(this@MainActivity, DetailActivity::class.java).putExtra("id", ad.items[pos].id))
            }
            setOnItemLongClickListener { _, _, pos, _ ->
                startActivity(Intent(this@MainActivity, EditActivity::class.java).putExtra("id", ad.items[pos].id))
                true
            }
        }
        listBox.addView(list, FrameLayout.LayoutParams(MATCH, MATCH))
        empty = text("", 15f, col(R.color.bp_text2)).apply { gravity = Gravity.CENTER; setPadding(dp(32), dp(48), dp(32), 0) }
        listBox.addView(empty, FrameLayout.LayoutParams(MATCH, WRAP))
        content.addView(listBox, lp(MATCH, 0, 1f))
        root.addView(content, FrameLayout.LayoutParams(MATCH, MATCH))

        // Bouton flottant « + »
        val fab = ImageButton(this).apply {
            setImageResource(R.drawable.ic_add)
            imageTintList = ColorStateList.valueOf(col(R.color.bp_on_accent))
            contentDescription = "Nouvelle entrée"
            background = ripple(GradientDrawable().apply {
                setColor(col(R.color.bp_accent)); cornerRadius = dp(20).toFloat()
            }, 20)
            elevation = dp(6).toFloat()
            setOnClickListener { startActivity(Intent(this@MainActivity, EditActivity::class.java)) }
        }
        val fabLp = FrameLayout.LayoutParams(dp(60), dp(60), Gravity.BOTTOM or Gravity.END)
        root.addView(fab, fabLp)

        setRoot(root) { l, t, r, b ->
            root.setPadding(l, t, r, 0)
            list.setPadding(0, 0, 0, dp(96) + b)
            fabLp.setMargins(0, 0, dp(20), dp(20) + b)
            fab.layoutParams = fabLp
        }
        content.fadeIn(dp(8))
        fab.scaleX = 0f; fab.scaleY = 0f
        fab.animate().scaleX(1f).scaleY(1f).setStartDelay(120).setDuration(220).start()
        refresh()
        // Identifiant saisi dans une appli pendant que le coffre était verrouillé
        app.biopass.autofill.Saver.offerPending(this) { refresh() }
    }

    private val live = LiveSearch { res -> showResults(res) }
    private var lastAll: List<Item> = emptyList()
    private var lastQuery = ""

    /** [typing] : appel depuis la barre de recherche (anti-rebond) ; sinon calcul immédiat. */
    private fun refresh(typing: Boolean = false) {
        adapter ?: return
        val v = Session.vault
        val all = v.list()
        val q = search?.text?.toString() ?: ""
        lastAll = all
        lastQuery = q
        offline?.visibility = if (v.online) View.GONE else View.VISIBLE
        count?.text = when (all.size) { 0 -> "Aucune entrée"; 1 -> "1 entrée"; else -> "${all.size} entrées" }
        if (!typing) Icons.prefetch(all)
        live.submit(if (typing) 30 else 0) { Search.search(all, q) }
    }

    private fun showResults(res: List<Item>) {
        val ad = adapter ?: return
        ad.items = res
        empty?.text = when {
            res.isNotEmpty() -> ""
            lastAll.isEmpty() -> "Votre coffre est vide.\nTouchez + pour ajouter une entrée."
            else -> "Aucun résultat pour « $lastQuery »"
        }
    }

    private fun sync() {
        val b = syncBtn ?: return
        b.animate().rotationBy(360f).setDuration(700).start()
        Session.run({
            val v = Session.vault
            if (v.api.token == null) v.reconnect() else v.sync()
        }) { r ->
            r.onSuccess {
                refresh()
                if (!Session.vault.online) toast("Serveur injoignable : vous êtes hors ligne")
            }.onFailure { handleError(it) }
        }
    }

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        val s = search
        if (showingList && s != null && s.text.isNotEmpty()) s.setText("") else super.onBackPressed()
    }
}
