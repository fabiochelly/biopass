package app.biopass

import android.app.Activity
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import app.biopass.core.ApiError
import app.biopass.core.BadPasswordException
import app.biopass.core.Domains
import app.biopass.core.Item

// ------------------------------------------------------------------ dimensions, couleurs

fun Context.dp(v: Number): Int = (v.toFloat() * resources.displayMetrics.density + 0.5f).toInt()
fun Context.col(id: Int): Int = getColor(id)

val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT

fun rounded(color: Int, radius: Float, strokeWidth: Int = 0, strokeColor: Int = 0) = GradientDrawable().apply {
    setColor(color)
    cornerRadius = radius
    if (strokeWidth > 0) setStroke(strokeWidth, strokeColor)
}

fun Context.ripple(content: Drawable?, radiusDp: Int): RippleDrawable {
    val mask = rounded(Color.WHITE, dp(radiusDp).toFloat())
    return RippleDrawable(ColorStateList.valueOf(withAlpha(col(R.color.bp_text), 0x22)), content, mask)
}

fun withAlpha(color: Int, alpha: Int) = (color and 0x00FFFFFF) or (alpha shl 24)

val MEDIUM: Typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
val MONO: Typeface = Typeface.MONOSPACE

fun lp(w: Int = MATCH, h: Int = WRAP, weight: Float = 0f, top: Int = 0, bottom: Int = 0, start: Int = 0, end: Int = 0) =
    LinearLayout.LayoutParams(w, h, weight).apply { topMargin = top; bottomMargin = bottom; marginStart = start; marginEnd = end }

// ------------------------------------------------------------------ composants

fun Context.vbox(padH: Int = 0, padV: Int = 0) = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    setPadding(dp(padH), dp(padV), dp(padH), dp(padV))
}

fun Context.hbox() = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
}

fun Context.text(s: CharSequence = "", size: Float = 16f, color: Int = col(R.color.bp_text), face: Typeface? = null) = TextView(this).apply {
    text = s
    textSize = size
    setTextColor(color)
    face?.let { typeface = it }
}

fun Context.label(s: String) = text(s, 13f, col(R.color.bp_text2), MEDIUM)

/** Bouton icône rond (ripple sans bordure). */
fun Context.iconButton(icon: Int, desc: String, tint: Int = col(R.color.bp_text), onClick: (View) -> Unit) = ImageButton(this).apply {
    setImageResource(icon)
    imageTintList = ColorStateList.valueOf(tint)
    contentDescription = desc
    background = RippleDrawable(ColorStateList.valueOf(withAlpha(col(R.color.bp_text), 0x22)), null, null)
    val p = dp(10)
    setPadding(p, p, p, p)
    scaleType = ImageView.ScaleType.FIT_CENTER
    layoutParams = LinearLayout.LayoutParams(dp(44), dp(44))
    if (Build.VERSION.SDK_INT >= 26) tooltipText = desc
    setOnClickListener(onClick)
}

enum class BtnStyle { PRIMARY, TONAL, OUTLINE, DANGER, TEXT }

/** Bouton « pilule » arrondi. */
fun Context.button(label: String, style: BtnStyle = BtnStyle.PRIMARY, icon: Int = 0, onClick: (View) -> Unit) = TextView(this).apply {
    text = label
    textSize = 15f
    typeface = MEDIUM
    gravity = Gravity.CENTER
    minHeight = dp(52)
    setPadding(dp(20), 0, dp(20), 0)
    isClickable = true
    isFocusable = true
    val r = dp(26).toFloat()
    val (bg, fg) = when (style) {
        BtnStyle.PRIMARY -> rounded(col(R.color.bp_accent), r) to col(R.color.bp_on_accent)
        BtnStyle.TONAL -> rounded(col(R.color.bp_accent_soft), r) to col(R.color.bp_on_accent_soft)
        BtnStyle.OUTLINE -> rounded(Color.TRANSPARENT, r, dp(1), col(R.color.bp_outline)) to col(R.color.bp_accent)
        BtnStyle.DANGER -> rounded(Color.TRANSPARENT, r, dp(1), withAlpha(col(R.color.bp_danger), 0x66)) to col(R.color.bp_danger)
        BtnStyle.TEXT -> null to col(R.color.bp_accent)
    }
    background = ripple(bg, 26)
    setTextColor(fg)
    if (icon != 0) {
        val d = getDrawable(icon)!!.mutate()
        d.setTint(fg)
        d.setBounds(0, 0, dp(20), dp(20))
        setCompoundDrawablesRelative(d, null, null, null)
        compoundDrawablePadding = dp(8)
    }
    setOnClickListener(onClick)
}

/** Carte arrondie (surface). */
fun Context.card(padDp: Int = 16) = vbox(padDp, padDp - 4).apply {
    background = rounded(col(R.color.bp_surface), dp(18).toFloat())
    layoutParams = lp(bottom = dp(10))
}

/** Champ de saisie « rempli » arrondi. */
fun Context.input(hint: String = "", value: String = "", type: Int = InputType.TYPE_CLASS_TEXT, lines: Int = 1) = EditText(this).apply {
    this.hint = hint
    setText(value)
    textSize = 16f
    setTextColor(col(R.color.bp_text))
    setHintTextColor(withAlpha(col(R.color.bp_text2), 0xAA))
    background = rounded(col(R.color.bp_surface2), dp(14).toFloat())
    setPadding(dp(16), dp(14), dp(16), dp(14))
    // setSingleLine() remplace la transformation « mot de passe » : il doit précéder inputType.
    if (lines > 1) {
        isSingleLine = false
        minLines = lines
        gravity = Gravity.TOP or Gravity.START
    } else {
        isSingleLine = true
    }
    inputType = type
    typeface = Typeface.DEFAULT // inputType « mot de passe » impose une police monospace (indice compris)
    if (Build.VERSION.SDK_INT >= 29) textCursorDrawable = rounded(col(R.color.bp_accent), 2f).apply { setSize(dp(2), 0) }
}

/** Champ + boutons icônes à droite, dans le même fond arrondi. */
fun Context.inputWithActions(edit: EditText, vararg actions: View): LinearLayout = hbox().apply {
    background = rounded(col(R.color.bp_surface2), dp(14).toFloat())
    edit.background = null
    addView(edit, lp(0, WRAP, 1f))
    for (a in actions) addView(a)
    setPadding(0, 0, dp(4), 0)
}

fun Context.labeled(title: String, view: View): LinearLayout = vbox().apply {
    addView(label(title), lp(bottom = dp(6), start = dp(4)))
    addView(view, lp())
    layoutParams = lp(bottom = dp(16))
}

private val AVATAR_COLORS = intArrayOf(
    0xFF3B82F6.toInt(), 0xFF8B5CF6.toInt(), 0xFFEC4899.toInt(), 0xFFF97316.toInt(), 0xFF10B981.toInt(), 0xFF14B8A6.toInt(),
    0xFFEF4444.toInt(), 0xFF6366F1.toInt(), 0xFF0EA5E9.toInt(), 0xFFF59E0B.toInt(), 0xFF84CC16.toInt(), 0xFFD946EF.toInt(),
)

fun avatarColor(name: String): Int {
    var h = 0
    for (c in name.lowercase()) h = h * 31 + c.code
    return AVATAR_COLORS[Math.floorMod(h, AVATAR_COLORS.size)]
}

/** Avatar rond coloré avec l'initiale du nom. */
fun Context.avatar(name: String, sizeDp: Int = 44) = TextView(this).apply {
    gravity = Gravity.CENTER
    setTextColor(Color.WHITE)
    typeface = MEDIUM
    // taille en px (indépendante de la taille de police système) pour rester dans le cercle
    setTextSize(TypedValue.COMPLEX_UNIT_PX, dp(sizeDp * 0.42f).toFloat())
    background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        gradientType = GradientDrawable.LINEAR_GRADIENT
        orientation = GradientDrawable.Orientation.TL_BR
    }
    layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
    bindAvatar(this, name)
}

/** Met à jour un avatar existant (pas de nouvelle vue : liste plus fluide). */
fun bindAvatar(tv: TextView, name: String, icon: android.graphics.Bitmap? = null, kind: String? = null) {
    val ctx = tv.context
    val size = tv.layoutParams?.width?.takeIf { it > 0 } ?: ctx.dp(44)
    if (icon != null) {
        // icône du site brute, directement sur le fond (coins arrondis et halo déjà appliqués)
        val bmp = android.graphics.drawable.BitmapDrawable(ctx.resources, icon).apply { isFilterBitmap = true }
        val inset = maxOf(1, size / 20)
        tv.background = android.graphics.drawable.InsetDrawable(bmp, inset)
        tv.text = ""
        return
    }
    val colors = kind?.let { app.biopass.core.Kinds.COLORS[it] }
    val res = when (kind) {
        "network" -> R.drawable.kind_network; "terminal" -> R.drawable.kind_terminal; "wifi" -> R.drawable.kind_wifi
        "card" -> R.drawable.kind_card; "key" -> R.drawable.kind_key; "app" -> R.drawable.kind_app; "note" -> R.drawable.kind_note
        else -> 0
    }
    if (colors != null && res != 0) {
        // tuile de catégorie : dégradé + pictogramme blanc (58 % de la tuile)
        val tile = GradientDrawable(GradientDrawable.Orientation.TL_BR, colors).apply { cornerRadius = size * 0.3f }
        val inset = (size * 0.21f).toInt()
        tv.background = android.graphics.drawable.LayerDrawable(arrayOf(tile, ctx.getDrawable(res)!!)).apply {
            setLayerInset(1, inset, inset, inset, inset)
        }
        tv.text = ""
        return
    }
    tv.text = name.trim().firstOrNull { it.isLetterOrDigit() }?.uppercaseChar()?.toString() ?: "•"
    val c = avatarColor(name)
    val g = (tv.background as? GradientDrawable)?.takeIf { it.shape == GradientDrawable.OVAL } ?: GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        gradientType = GradientDrawable.LINEAR_GRADIENT
        orientation = GradientDrawable.Orientation.TL_BR
    }.also { tv.background = it }
    g.colors = intArrayOf(c, darken(c))
}

/** Avatar d'une entrée : icône du site si disponible (décodée hors du thread UI), sinon initiale. */
fun bindItemAvatar(tv: TextView, it: Item) {
    val name = it.name.ifBlank { "?" }
    val icon = Icons.cached(it)
    bindAvatar(tv, name, icon, if (icon == null) it.kind else null)
    tv.tag = it.id
    if (icon == null && it.icon != null) Icons.load(it) { b -> if (tv.tag == it.id) bindAvatar(tv, name, b) }
}

/**
 * Recherche hors du thread UI : chaque frappe annule la précédente (anti-rebond court + génération),
 * seul le dernier résultat est livré sur le thread UI.
 */
class LiveSearch(private val deliver: (List<Item>) -> Unit) {
    @Volatile private var gen = 0
    private var pending: Runnable? = null

    fun submit(delayMs: Long, compute: () -> List<Item>) {
        val g = ++gen
        pending?.let { Session.main.removeCallbacks(it) }
        val r = Runnable {
            EXEC.execute {
                if (g != gen) return@execute
                val res = compute()
                Session.main.post { if (g == gen) deliver(res) }
            }
        }
        pending = r
        if (delayMs <= 0) r.run() else Session.main.postDelayed(r, delayMs)
    }

    companion object {
        private val EXEC = java.util.concurrent.Executors.newSingleThreadExecutor()
    }
}

private fun darken(c: Int): Int {
    val f = 0.78f
    return Color.rgb((Color.red(c) * f).toInt(), (Color.green(c) * f).toInt(), (Color.blue(c) * f).toInt())
}

fun TextView.onChange(f: (String) -> Unit) = addTextChangedListener(object : TextWatcher {
    override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
    override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
    override fun afterTextChanged(s: Editable?) = f(s?.toString() ?: "")
})

fun EditText.onDone(f: () -> Unit) = setOnEditorActionListener { _, id, ev ->
    if (id == EditorInfo.IME_ACTION_DONE || id == EditorInfo.IME_ACTION_GO || ev?.keyCode == android.view.KeyEvent.KEYCODE_ENTER) {
        f(); true
    } else false
}

fun View.fadeIn(dy: Int = 0) {
    alpha = 0f
    translationY = dy.toFloat()
    animate().alpha(1f).translationY(0f).setDuration(220).start()
}

fun View.hideKeyboard() = context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(windowToken, 0)
fun View.showKeyboard() {
    requestFocus()
    postDelayed({ context.getSystemService(InputMethodManager::class.java).showSoftInput(this, 0) }, 150)
}

/** Sous-titre d'une entrée dans les listes : identifiant, sinon domaine. */
fun Item.subtitle(): String = username.ifBlank {
    uris.firstOrNull()?.let { u -> if (Domains.isAppUri(u)) u.substringAfter("://") else Domains.hostOf(u) } ?: folder
}

// ------------------------------------------------------------------ activité de base

/**
 * FLAG_SECURE, edge-to-edge, verrouillage automatique et gestion uniforme des erreurs.
 */
abstract class BaseActivity : Activity() {
    /** true : l'écran a besoin du coffre déverrouillé (sinon [onLocked]). */
    open val needsUnlock = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Session.init(this)
        if (resources.getBoolean(R.bool.bp_secure)) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (Build.VERSION.SDK_INT >= 30) {
            @Suppress("DEPRECATION") // sans effet (déjà edge-to-edge) à partir d'Android 15
            window.setDecorFitsSystemWindows(false)
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = window.decorView.systemUiVisibility or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
    }

    override fun onResume() {
        super.onResume()
        if (needsUnlock && !Session.unlocked) {
            onLocked()
            return
        }
        if (Session.vault.unlocked) Session.touch()
    }

    override fun onUserInteraction() {
        super.onUserInteraction()
        if (Session.vault.unlocked) Session.touch()
    }

    /** Coffre verrouillé : par défaut on revient à l'écran principal (qui affiche le déverrouillage). */
    open fun onLocked() = finish()

    /**
     * Affiche [root] en plein écran ; [onInsets] reçoit (gauche, haut, droite, bas) — barres système + clavier.
     * Par défaut, applique les marges en padding du root.
     */
    fun setRoot(root: View, onInsets: ((Int, Int, Int, Int) -> Unit)? = null) {
        val base = intArrayOf(root.paddingLeft, root.paddingTop, root.paddingRight, root.paddingBottom)
        root.setOnApplyWindowInsetsListener { v, insets ->
            val l: Int; val t: Int; val r: Int; val b: Int
            if (Build.VERSION.SDK_INT >= 30) {
                val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime() or WindowInsets.Type.displayCutout())
                l = i.left; t = i.top; r = i.right; b = i.bottom
            } else {
                @Suppress("DEPRECATION")
                run { l = insets.systemWindowInsetLeft; t = insets.systemWindowInsetTop; r = insets.systemWindowInsetRight; b = insets.systemWindowInsetBottom }
            }
            if (onInsets != null) onInsets(l, t, r, b) else v.setPadding(base[0] + l, base[1] + t, base[2] + r, base[3] + b)
            insets
        }
        setContentView(root)
        root.requestApplyInsets()
    }

    fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()

    /** Message d'erreur lisible + reverrouillage sur 401. */
    open fun handleError(e: Throwable) {
        if (e is ApiError && e.status == 401) {
            Session.lock()
            toast("Session expirée : déverrouillez à nouveau")
            onLocked()
            return
        }
        toast(errorMessage(e))
    }

    /** Barre du haut : retour + titre + actions. */
    fun topBar(title: String, backIcon: Int = R.drawable.ic_back, vararg actions: View): LinearLayout = hbox().apply {
        setPadding(dp(4), dp(4), dp(8), dp(4))
        minimumHeight = dp(60)
        addView(iconButton(backIcon, "Retour") { finish() })
        addView(text(title, 20f, face = MEDIUM).apply { isSingleLine = true; ellipsize = android.text.TextUtils.TruncateAt.END }, lp(0, WRAP, 1f, start = dp(8)))
        for (a in actions) addView(a)
    }
}

fun errorMessage(e: Throwable): String = when {
    e is BadPasswordException -> "Mot de passe incorrect"
    e is ApiError && e.status == 0 -> "Serveur injoignable : vous êtes hors ligne"
    e is ApiError && e.status == 401 -> "Identifiant ou mot de passe incorrect"
    e is ApiError && e.status == 404 -> "Serveur introuvable ou clé d'accès incorrecte"
    e is ApiError && e.status == 409 ->
        "Modifiée entre-temps sur un autre appareil. Données resynchronisées : vérifiez puis recommencez."
    else -> e.message ?: "Erreur inattendue"
}

// ------------------------------------------------------------------ liste d'entrées

/**
 * Adaptateur de liste partagé (écran principal, recherche de la saisie automatique).
 * [copyButtons] : icônes « copier l'identifiant » (personne) et « copier le mot de passe » (clé).
 */
class ItemAdapter(private val ctx: Context, private val copyButtons: Boolean = false) : BaseAdapter() {
    var items: List<Item> = emptyList()
        set(v) {
            if (v == field) return // mêmes entrées (mêmes objets) dans le même ordre : rien à redessiner
            field = v
            notifyDataSetChanged()
        }

    override fun getCount() = items.size
    override fun getItem(position: Int) = items[position]
    override fun getItemId(position: Int) = items[position].id.hashCode().toLong()

    private class Holder(val avatar: TextView, val name: TextView, val sub: TextView, val star: ImageView,
                         val copyUser: ImageButton?, val copyPw: ImageButton?)

    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
        val view = convertView ?: build()
        val h = view.tag as Holder
        val it = items[position]
        bindItemAvatar(h.avatar, it)
        h.name.text = it.name.ifBlank { "(sans nom)" }
        val sub = it.subtitle()
        h.sub.text = sub
        h.sub.visibility = if (sub.isEmpty()) View.GONE else View.VISIBLE
        h.star.visibility = if (it.fav) View.VISIBLE else View.GONE
        bindCopy(h.copyUser, it.username, "Identifiant", R.drawable.ic_person)
        bindCopy(h.copyPw, it.password, "Mot de passe", R.drawable.ic_key)
        return view
    }

    private fun bindCopy(b: ImageButton?, value: String, label: String, icon: Int) {
        b ?: return
        b.visibility = if (value.isEmpty()) View.GONE else View.VISIBLE
        b.setImageResource(icon)
        b.imageTintList = ColorStateList.valueOf(ctx.col(R.color.bp_accent))
        b.setOnClickListener {
            Session.copy(ctx, label, value)
            // Retour visuel bref : ✓ puis l'icône d'origine
            b.setImageResource(R.drawable.ic_check)
            b.animate().cancel()
            b.scaleX = 0.6f; b.scaleY = 0.6f
            b.animate().scaleX(1f).scaleY(1f).setDuration(160).start()
            b.postDelayed({ b.setImageResource(icon) }, 1200)
        }
    }

    private fun build(): View = with(ctx) {
        val outer = FrameLayout(this).apply { setPadding(dp(8), dp(2), dp(4), dp(2)) }
        val row = hbox().apply {
            setPadding(dp(12), dp(10), 0, dp(10))
            background = ripple(null, 16)
            isDuplicateParentStateEnabled = true
        }
        val avatarView = avatar("?")
        row.addView(avatarView, LinearLayout.LayoutParams(dp(44), dp(44)))
        val texts = vbox()
        val name = text("", 16f, face = MEDIUM).apply { isSingleLine = true; ellipsize = android.text.TextUtils.TruncateAt.END }
        val sub = text("", 14f, col(R.color.bp_text2)).apply { isSingleLine = true; ellipsize = android.text.TextUtils.TruncateAt.END }
        texts.addView(name)
        texts.addView(sub, lp(top = dp(1)))
        // largeur 0 + poids 1 : les textes longs sont tronqués « … », les icônes restent visibles
        row.addView(texts, lp(0, WRAP, 1f, start = dp(14)))
        val star = ImageView(this).apply {
            setImageResource(R.drawable.ic_star)
            imageTintList = ColorStateList.valueOf(0xFFF59E0B.toInt())
        }
        row.addView(star, LinearLayout.LayoutParams(dp(18), dp(18)).apply { marginStart = dp(4); marginEnd = dp(2) })
        fun copyBtn(desc: String) = iconButton(R.drawable.ic_copy, desc, col(R.color.bp_accent)) {}.apply {
            isFocusable = false
            layoutParams = LinearLayout.LayoutParams(dp(46), dp(46))
            val p = dp(11)
            setPadding(p, p, p, p)
        }
        val copyUser = if (copyButtons) copyBtn("Copier l'identifiant").also { row.addView(it) } else null
        val copyPw = if (copyButtons) copyBtn("Copier le mot de passe").also { row.addView(it) } else null
        outer.addView(row, FrameLayout.LayoutParams(MATCH, WRAP))
        outer.tag = Holder(avatarView, name, sub, star, copyUser, copyPw)
        outer
    }
}
