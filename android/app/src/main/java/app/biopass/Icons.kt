package app.biopass

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import app.biopass.core.Item
import java.util.concurrent.Executors

/**
 * Icônes des sites (champ `icon` des entrées, PNG 48×48 en data URL) : décodées une seule fois,
 * hors du thread UI, et gardées en cache (clé = entrée + valeur de l'icône).
 */
object Icons {
    private val cache = object : LruCache<String, Bitmap>(16 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private val failed = HashSet<String>()
    private val exec = Executors.newSingleThreadExecutor()

    private fun night() = (Session.app.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
        android.content.res.Configuration.UI_MODE_NIGHT_YES

    /** Clé de cache : entrée + valeur de l'icône + ton + thème (le halo dépend du thème). */
    fun key(it: Item): String? = it.icon?.let { s -> it.id + ":" + s.length + ":" + s.hashCode() + ":" + it.iconTone + ":" + night() }

    /** Bitmap déjà décodé, ou null. */
    fun cached(it: Item): Bitmap? = key(it)?.let { k -> cache.get(k) }

    /** Décode tout de suite (thread courant) : saisie automatique, petite quantité. */
    fun now(it: Item): Bitmap? {
        val k = key(it) ?: return null
        cache.get(k)?.let { b -> return b }
        return decode(k, it)
    }

    @Synchronized private fun isFailed(k: String) = k in failed

    private fun decode(k: String, it: Item): Bitmap? {
        if (isFailed(k)) return null
        val bytes = it.iconBytes()
        val bmp = bytes?.let { b -> BitmapFactory.decodeByteArray(b, 0, b.size) }?.let { b -> render(b, it.iconTone, night()) }
        if (bmp == null) synchronized(this) { failed.add(k) } else cache.put(k, bmp)
        return bmp
    }

    /** Décode en arrière-plan puis appelle [done] sur le thread UI (si l'icône est valide). */
    fun load(it: Item, done: (Bitmap) -> Unit) {
        val k = key(it) ?: return
        cache.get(k)?.let { b -> return done(b) }
        exec.execute {
            val b = decode(k, it) ?: return@execute
            Session.main.post { done(b) }
        }
    }

    /** Pré-décodage des icônes du coffre (après déverrouillage / synchro). */
    fun prefetch(items: Collection<Item>) {
        val todo = items.filter { it.icon != null && cached(it) == null }
        if (todo.isEmpty()) return
        exec.execute { for (it in todo) key(it)?.let { k -> if (cache.get(k) == null) decode(k, it) } }
    }

    /**
     * Icône brute aux coins légèrement arrondis (~6dp sur ~40dp) ; logo très sombre en thème sombre :
     * pastille blanche ; très clair en thème clair : léger contour pour rester visible (comme le site).
     */
    private fun render(src: Bitmap, tone: String, night: Boolean): Bitmap {
        val w = src.width
        val h = src.height
        if (tone == "dark" && night) {
            val pad = w / 6
            val out = Bitmap.createBitmap(w + 2 * pad, h + 2 * pad, Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(out)
            val side = (w + 2 * pad).toFloat()
            canvas.drawRoundRect(android.graphics.RectF(0f, 0f, side, side), side * 0.3f, side * 0.3f,
                android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.WHITE })
            canvas.drawBitmap(src, pad.toFloat(), pad.toFloat(), android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG))
            return out
        }
        val pad = maxOf(2, w / 20)
        val out = Bitmap.createBitmap(w + 2 * pad, h + 2 * pad, Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(out)
        val rounded = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        android.graphics.Canvas(rounded).drawRoundRect(android.graphics.RectF(0f, 0f, w.toFloat(), h.toFloat()), w * 0.15f, h * 0.15f,
            android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
                shader = android.graphics.BitmapShader(src, android.graphics.Shader.TileMode.CLAMP, android.graphics.Shader.TileMode.CLAMP)
            })
        val halo = if (tone == "light" && !night) 0x8C0F172A.toInt() else 0 // ardoise 55 %
        if (halo != 0) {
            // halo flou autour de la silhouette (équivalent du drop-shadow(0 0 1px) du site, appliqué deux fois)
            val blur = android.graphics.Paint().apply { maskFilter = android.graphics.BlurMaskFilter(pad * 0.6f, android.graphics.BlurMaskFilter.Blur.NORMAL) }
            val off = IntArray(2)
            val shape = rounded.extractAlpha(blur, off)
            val p = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = halo }
            repeat(3) { canvas.drawBitmap(shape, (pad + off[0]).toFloat(), (pad + off[1]).toFloat(), p) }
            shape.recycle()
        }
        canvas.drawBitmap(rounded, pad.toFloat(), pad.toFloat(), null)
        rounded.recycle()
        return out
    }
}
