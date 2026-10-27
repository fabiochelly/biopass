package app.biopass.autofill

import android.app.ActivityOptions
import android.app.PendingIntent
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.graphics.drawable.Icon
import android.os.Build
import android.service.autofill.Dataset
import android.service.autofill.FillResponse
import android.service.autofill.InlinePresentation
import android.service.autofill.SaveInfo
import android.view.View
import android.view.inputmethod.InlineSuggestionsRequest
import android.widget.inline.InlinePresentationSpec
import android.annotation.TargetApi
import androidx.autofill.inline.UiVersions
import androidx.autofill.inline.v1.InlineSuggestionUi
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import app.biopass.R
import app.biopass.Session
import app.biopass.core.Domains
import app.biopass.core.FieldClassifier
import app.biopass.core.FieldInfo
import app.biopass.core.Form
import app.biopass.core.Item
import app.biopass.core.Search
import app.biopass.core.Totp
import app.biopass.core.ApiError
import app.biopass.core.Change
import app.biopass.core.withHistory
import org.json.JSONArray
import org.json.JSONObject
import app.biopass.subtitle
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

/** Cible d'un formulaire : site web (navigateur) ou application. */
sealed class Target {
    data class Web(val domain: String) : Target()
    data class App(val pkg: String) : Target()
    object Unknown : Target()

    /** URI à associer à une entrée pour la retrouver directement la prochaine fois. */
    val uri: String?
        get() = when (this) {
            is Web -> "https://$domain"
            is App -> Domains.appUri(pkg)
            Unknown -> null
        }

    fun matches(it: Item) = when (this) {
        is Web -> Domains.matchesWebDomain(it, domain)
        is App -> Domains.matchesApp(it, pkg)
        Unknown -> false
    }

    fun label(ctx: Context): String = when (this) {
        is Web -> Domains.baseDomain(domain)
        is App -> appLabel(ctx, pkg)
        Unknown -> "Nouvelle entrée"
    }
}

private val SKIP_SEGMENTS = setOf("com", "org", "net", "fr", "de", "io", "co", "app", "apps", "android", "mobile", "www", "eu", "uk", "be", "ch")

fun appLabel(ctx: Context, pkg: String): String = try {
    ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(pkg, 0)).toString()
} catch (e: Exception) {
    val seg = pkg.split('.').firstOrNull { it.lowercase(Locale.ROOT) !in SKIP_SEGMENTS } ?: pkg
    seg.replaceFirstChar { it.titlecase(Locale.ROOT) }
}

/** Écrans système (code PIN de l'appareil, etc.) : jamais de saisie automatique BioPass. */
val IGNORED_PACKAGES = setOf("android", "com.android.settings", "com.android.systemui", "com.google.android.settings.intelligence")

/** Navigateurs : sans webDomain, on ne peut pas savoir quel site est affiché. */
val BROWSERS = setOf(
    "com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary", "com.brave.browser", "com.brave.browser_beta",
    "com.brave.browser_nightly", "org.mozilla.firefox", "org.mozilla.firefox_beta", "org.mozilla.fenix", "org.mozilla.focus",
    "com.sec.android.app.sbrowser", "com.sec.android.app.sbrowser.beta", "com.microsoft.emmx", "com.opera.browser",
    "com.opera.mini.native", "com.vivaldi.browser", "com.duckduckgo.mobile.android", "com.kiwibrowser.browser",
    "org.chromium.chrome", "com.ecosia.android", "org.bromite.bromite", "com.yandex.browser", "com.mi.globalbrowser",
    "com.huawei.browser", "mark.via.gp", "org.torproject.torbrowser", "us.spotco.fennec_dos",
    "io.github.forkmaintainers.iceraven", "com.cookiegames.smartcookie", "app.vanadium.browser",
)

class Parsed(val form: Form, val target: Target, val pkg: String) {
    val ids: Array<AutofillId> get() = form.all.map { it.ref as AutofillId }.distinct().toTypedArray()
    private fun firstValue(list: List<FieldInfo>) = list.firstNotNullOfOrNull { it.value?.takeIf { v -> v.isNotBlank() } }
    val usernameValue get() = firstValue(form.usernames)
    val passwordValue get() = firstValue(form.passwords)
}

/** Parcourt tous les nœuds de toutes les fenêtres de l'AssistStructure. */
object Parser {
    fun parse(structure: AssistStructure): Parsed {
        val fields = ArrayList<FieldInfo>()
        for (i in 0 until structure.windowNodeCount) walk(structure.getWindowNodeAt(i).rootViewNode, null, fields)
        val form = FieldClassifier.analyze(fields)
        val pkg = structure.activityComponent?.packageName ?: ""
        val domain = form.all.firstNotNullOfOrNull { it.webDomain } ?: fields.firstNotNullOfOrNull { it.webDomain }
        val target = when {
            domain != null -> Target.Web(domain.lowercase(Locale.ROOT))
            pkg in BROWSERS || pkg.isEmpty() -> Target.Unknown
            else -> Target.App(pkg)
        }
        return Parsed(form, target, pkg)
    }

    private fun walk(n: AssistStructure.ViewNode, parentDomain: String?, out: MutableList<FieldInfo>) {
        val domain = n.webDomain?.takeIf { it.isNotBlank() } ?: parentDomain
        val id = n.autofillId
        val html = n.htmlInfo
        if (id != null && (n.autofillType == View.AUTOFILL_TYPE_TEXT || html?.tag.equals("input", true))) {
            val attrs = HashMap<String, String>()
            html?.attributes?.forEach { p -> if (p.first != null && p.second != null) attrs[p.first.lowercase(Locale.ROOT)] = p.second }
            val av = n.autofillValue
            out.add(FieldInfo(
                ref = id,
                isText = n.autofillType == View.AUTOFILL_TYPE_TEXT,
                visible = n.visibility == View.VISIBLE,
                hints = n.autofillHints?.toList() ?: emptyList(),
                inputType = n.inputType,
                htmlTag = html?.tag,
                htmlAttrs = attrs,
                idEntry = n.idEntry,
                hint = n.hint,
                label = n.contentDescription?.toString(),
                value = if (av != null && av.isText) av.textValue?.toString() else n.text?.toString(),
                webDomain = domain,
            ))
        }
        for (i in 0 until n.childCount) walk(n.getChildAt(i), domain, out)
    }
}

/** Suggestions dans la barre du clavier (Android 11+, InlineSuggestionUi d'AndroidX). */
@TargetApi(30)
object Inline {
    fun spec(req: InlineSuggestionsRequest, i: Int): InlinePresentationSpec {
        val specs = req.inlinePresentationSpecs
        return specs[minOf(i, specs.size - 1)] // le dernier spec s'applique aux suivants
    }

    /**
     * Chip compacte : texte court seul, ou icône seule. [tint] : couleur de l'icône (pastille).
     * null si le clavier ne gère pas ce style.
     */
    fun create(ctx: Context, spec: InlinePresentationSpec, title: String?, icon: Int, desc: String, pinned: Boolean = false,
               tint: Int? = null): InlinePresentation? {
        if (!UiVersions.getVersions(spec.style).contains(UiVersions.INLINE_UI_VERSION_1)) return null
        val attribution = PendingIntent.getActivity(ctx, 0, Intent(ctx, app.biopass.MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = InlineSuggestionUi.newContentBuilder(attribution).setContentDescription(desc)
        if (title != null) b.setTitle(title)
        if (tint != null) b.setStartIcon(dot(ctx, tint))
        else if (icon != 0) b.setStartIcon(Icon.createWithResource(ctx, icon))
        return InlinePresentation(b.build().slice, spec, pinned)
    }

    /**
     * Pastille de couleur : bitmap à couleur propre (le clavier teinte les icônes à sa façon ; la
     * teinte est neutralisée par BlendMode.DST), petit disque au centre d'une marge transparente.
     */
    private fun dot(ctx: Context, color: Int): Icon {
        // Taille intrinsèque = taille affichée par le clavier (~24dp) : sinon la chip est mesurée
        // trop étroite et le texte tronqué.
        val size = (24 * ctx.resources.displayMetrics.density).toInt()
        val bmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { this.color = color }
        android.graphics.Canvas(bmp).drawCircle(size / 2f, size / 2f, size * 0.22f, paint)
        return Icon.createWithBitmap(bmp).apply {
            setTintBlendMode(android.graphics.BlendMode.DST)
        }
    }
}

/** Construction des réponses de saisie automatique. */
object Responses {
    const val MODE = "mode"
    const val MODE_AUTH = "auth"
    const val MODE_PICK = "pick"
    const val MODE_SAVE = "save"
    private val requestCode = AtomicInteger(1)

    /** Dernière InlineSuggestionsRequest reçue (pour la réponse rendue après déverrouillage). */
    @Volatile var lastInline: Any? = null

    fun matching(t: Target): List<Item> = Search.search(Session.vault.list().filter { t.matches(it) }, "")

    fun sender(ctx: Context, mode: String, extra: (Intent) -> Unit = {}): IntentSender {
        val i = Intent(ctx, AutofillActivity::class.java).putExtra(MODE, mode)
        extra(i)
        // Mutable : le système y ajoute l'AssistStructure (EXTRA_ASSIST_STRUCTURE).
        val flags = PendingIntent.FLAG_CANCEL_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        // Android 14+ : sans cette option, le système bloque le lancement de l'activité depuis
        // l'arrière-plan (cas de l'enregistrement, lancé après la fermeture du formulaire).
        val options = if (Build.VERSION.SDK_INT >= 34) {
            @Suppress("DEPRECATION")
            ActivityOptions.makeBasic()
                .setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
                .toBundle()
        } else null
        return PendingIntent.getActivity(ctx, requestCode.getAndIncrement(), i, flags, options).intentSender
    }

    /** Ligne de la liste déroulante : une seule ligne, texte principal + texte secondaire en petit. */
    fun presentation(ctx: Context, title: String, sub: String, icon: Int, dot: Int? = null, bitmap: android.graphics.Bitmap? = null) =
        RemoteViews(ctx.packageName, R.layout.autofill_item).apply {
        setTextViewText(R.id.af_title, title)
        setTextViewText(R.id.af_sub, sub)
        setViewVisibility(R.id.af_sub, if (sub.isEmpty()) View.GONE else View.VISIBLE)
        if (bitmap != null) {
            setImageViewBitmap(R.id.af_icon, bitmap) // icône du site
        } else if (dot != null) {
            setViewVisibility(R.id.af_icon, View.GONE)
            setViewVisibility(R.id.af_dot, View.VISIBLE)
            setInt(R.id.af_dot, "setColorFilter", dot)
        } else {
            setImageViewResource(R.id.af_icon, icon)
        }
    }

    /** Jeu de valeurs pour une entrée ; null s'il n'y a rien à remplir. */
    @Suppress("DEPRECATION")
    fun dataset(ctx: Context, p: Parsed, item: Item, inline: InlinePresentation? = null): Dataset? {
        val title = item.username.trim().ifBlank { item.name.trim() }.ifBlank { "(sans nom)" }
        val sub = if (item.username.isNotBlank()) item.name.trim() else ""
        val b = Dataset.Builder(presentation(ctx, title, sub, R.drawable.ic_logo, app.biopass.core.Palette.color(item), app.biopass.Icons.now(item)))
        if (inline != null && Build.VERSION.SDK_INT >= 30) b.setInlinePresentation(inline)
        var any = false
        // Identifiant : filtrage par défaut d'Android (« commence par », insensible à la casse) sur la
        // valeur. Mot de passe / code : non filtrable (filtre null) — jamais de filtrage sur un secret,
        // la suggestion disparaît dès qu'il y a du texte dans le champ.
        fun put(fields: List<FieldInfo>, v: String?, filterable: Boolean) {
            if (v.isNullOrEmpty()) return
            for (f in fields) {
                if (filterable) b.setValue(f.ref as AutofillId, AutofillValue.forText(v))
                else b.setValue(f.ref as AutofillId, AutofillValue.forText(v), null)
                any = true
            }
        }
        put(p.form.usernames, item.username, true)
        put(p.form.passwords, item.password, false)
        if (p.form.otps.isNotEmpty()) put(p.form.otps, Totp.codeOrNull(item.totp)?.code, false)
        return if (any) b.build() else null
    }

    @Suppress("DEPRECATION")
    private fun searchDataset(ctx: Context, p: Parsed, inline: InlinePresentation?): Dataset {
        val sub = if (p.target is Target.Unknown) "" else p.target.label(ctx)
        val b = Dataset.Builder(presentation(ctx, "Rechercher dans BioPass…", sub, R.drawable.ic_search))
        if (inline != null && Build.VERSION.SDK_INT >= 30) b.setInlinePresentation(inline)
        for (id in p.ids) b.setValue(id, null)
        b.setAuthentication(sender(ctx, MODE_PICK))
        return b.build()
    }

    private fun saveInfo(p: Parsed): SaveInfo? {
        val pw = p.form.passwords.map { it.ref as AutofillId }.distinct()
        if (pw.isEmpty()) return null
        val users = p.form.usernames.map { it.ref as AutofillId }.filter { it !in pw }.distinct()
        val type = SaveInfo.SAVE_DATA_TYPE_PASSWORD or (if (users.isNotEmpty()) SaveInfo.SAVE_DATA_TYPE_USERNAME else 0)
        return SaveInfo.Builder(type, pw.toTypedArray()).apply {
            if (users.isNotEmpty()) setOptionalIds(users.toTypedArray())
            setFlags(SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE)
        }.build()
    }

    /**
     * Réponse complète : verrouillé → authentification ; déverrouillé → suggestions + recherche.
     * [inlineRequest] (InlineSuggestionsRequest, Android 11+) : chips dans la barre du clavier en
     * plus de la liste déroulante (le système choisit selon le clavier).
     */
    @Suppress("DEPRECATION")
    fun build(ctx: Context, p: Parsed, inlineRequest: Any? = lastInline): FillResponse {
        val req = if (Build.VERSION.SDK_INT >= 30) inlineRequest as? InlineSuggestionsRequest else null
        val b = FillResponse.Builder()
        if (!Session.unlocked) {
            val sub = if (p.target is Target.Unknown) "Déverrouiller" else "Déverrouiller pour ${p.target.label(ctx)}"
            val menu = presentation(ctx, "BioPass verrouillé", sub, R.drawable.ic_lock)
            val ip = if (req != null && Build.VERSION.SDK_INT >= 30)
                Inline.create(ctx, Inline.spec(req, 0), "BioPass", R.drawable.ic_lock, "Déverrouiller BioPass") else null
            if (ip != null && Build.VERSION.SDK_INT >= 30) b.setAuthentication(p.ids, sender(ctx, MODE_AUTH), menu, ip)
            else b.setAuthentication(p.ids, sender(ctx, MODE_AUTH), menu)
        } else {
            val max = if (req != null && Build.VERSION.SDK_INT >= 30) req.maxSuggestionCount else Int.MAX_VALUE
            // la place restante va aux entrées ; « Rechercher » toujours en dernier
            val items = matching(p.target).take(minOf(12, maxOf(0, max - 1)))
            val labels = app.biopass.core.chipLabels(items)
            var n = 0
            for ((i, item) in items.withIndex()) {
                val ip = if (req != null && Build.VERSION.SDK_INT >= 30)
                    Inline.create(ctx, Inline.spec(req, n), labels[i], R.drawable.dot, "${item.name} ${item.username}".trim(),
                        tint = app.biopass.core.Palette.color(item)) else null
                dataset(ctx, p, item, ip)?.let { b.addDataset(it); n++ }
            }
            if (max > 0) {
                val ip = if (req != null && Build.VERSION.SDK_INT >= 30)
                    Inline.create(ctx, Inline.spec(req, n), null, R.drawable.ic_search, "Rechercher dans BioPass", pinned = true) else null
                b.addDataset(searchDataset(ctx, p, ip))
            }
        }
        saveInfo(p)?.let { b.setSaveInfo(it) }
        return b.build()
    }
}

/**
 * Demande d'enregistrement en attente, gardée en mémoire seulement (jamais dans un Intent ni
 * sur disque), 10 minutes au plus.
 */
object PendingSave {
    class Data(val target: Target, val username: String?, val password: String) {
        val time = android.os.SystemClock.elapsedRealtime()
    }

    private var token: String? = null
    private var data: Data? = null

    @Synchronized fun put(d: Data): String {
        val t = java.util.UUID.randomUUID().toString()
        token = t
        data = d
        return t
    }

    @Synchronized fun peek(): Data? {
        val d = data ?: return null
        if (android.os.SystemClock.elapsedRealtime() - d.time > 10 * 60_000L) clear()
        return data
    }

    @Synchronized fun take(t: String?): Data? = if (t != null && t == token) peek().also { clear() } else null
    @Synchronized fun takeAny(): Data? = peek().also { clear() }
    @Synchronized fun has(t: String) = t == token && peek() != null
    @Synchronized fun clear() { token = null; data = null }
}

/** Enregistrement d'un identifiant saisi (thread de fond). */
object Saver {
    /** Met à jour l'entrée de même identifiant pour cette cible, sinon en crée une. Retourne le message à afficher. */
    fun save(d: PendingSave.Data, label: String): String {
        val v = Session.vault
        if (!v.unlocked) throw IllegalStateException("Coffre verrouillé")
        if (v.api.token == null && !v.reconnect()) throw ApiError(0, "Hors ligne : connexion au serveur nécessaire pour enregistrer")
        val user = d.username?.trim().orEmpty()
        val existing = Responses.matching(d.target).firstOrNull { it.username.trim().equals(user, ignoreCase = true) }
        if (existing != null) {
            if (existing.password == d.password) return "Déjà enregistré dans « ${existing.name} »"
            val next = withHistory(existing, existing.copyData().put("password", d.password))
            v.save(listOf(Change.Put(next, existing.id)))
            return "Mot de passe mis à jour : ${existing.name}"
        }
        val obj = JSONObject()
            .put("type", "login")
            .put("name", label)
            .put("username", user)
            .put("password", d.password)
            .put("uris", JSONArray().apply { d.target.uri?.let { put(it) } })
            .put("totp", "")
            .put("notes", "")
        v.save(listOf(Change.Put(obj)))
        return "Ajouté à BioPass : $label"
    }

    /** Dialogue proposé à l'ouverture de BioPass si un enregistrement n'a pas pu aboutir. */
    fun offerPending(act: app.biopass.BaseActivity, onDone: () -> Unit = {}) {
        val d = PendingSave.peek() ?: return
        val label = d.target.label(act)
        android.app.AlertDialog.Builder(act)
            .setTitle("Enregistrer l'identifiant ?")
            .setMessage(label + (d.username?.takeIf { it.isNotBlank() }?.let { "\n$it" } ?: ""))
            .setPositiveButton("Enregistrer") { _, _ ->
                val data = PendingSave.takeAny() ?: return@setPositiveButton
                Session.run({ save(data, label) }) { r ->
                    r.onSuccess { act.toast(it); onDone() }.onFailure { e ->
                        if (e is ApiError && e.status == 0) PendingSave.put(data)
                        act.handleError(e)
                    }
                }
            }
            .setNegativeButton("Ignorer") { _, _ -> PendingSave.clear() }
            .show()
    }
}
