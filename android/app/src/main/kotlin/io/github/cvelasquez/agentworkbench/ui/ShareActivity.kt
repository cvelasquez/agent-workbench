package io.github.cvelasquez.agentworkbench.ui

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.format.DateUtils
import android.util.TypedValue
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import io.github.cvelasquez.agentworkbench.BuildConfig
import io.github.cvelasquez.agentworkbench.R
import io.github.cvelasquez.agentworkbench.core.PhoneIdentity
import io.github.cvelasquez.agentworkbench.core.ServerMessage
import io.github.cvelasquez.agentworkbench.core.SharedItems
import io.github.cvelasquez.agentworkbench.store.PairedPc
import io.github.cvelasquez.agentworkbench.store.PcStore
import io.github.cvelasquez.agentworkbench.tunnel.Tunnel
import io.github.cvelasquez.agentworkbench.tunnel.TunnelProblem
import io.github.cvelasquez.agentworkbench.tunnel.TunnelService
import io.github.cvelasquez.agentworkbench.tunnel.TunnelStatus
import io.github.cvelasquez.agentworkbench.watch.NoteUpload
import io.github.cvelasquez.agentworkbench.watch.NotesClient
import io.github.cvelasquez.agentworkbench.watch.SharedImage
import java.io.ByteArrayOutputStream
import java.io.IOException
import kotlin.concurrent.thread

/**
 * Compartir a una nota (hito 50, §15.12): la pantalla que aparece en "Compartir" de
 * cualquier app, para imágenes y texto. Lista las notas de la PC y lo compartido va
 * a la que se toque, o a una nueva, con el comentario que se escriba. Después vuelve
 * sola a la app desde la que se compartió.
 *
 * Es la única pantalla que muestra algo de la PC sin la web (N1 pedía casi ninguna
 * propia): compartir es del sistema, y por la web habría que cargar la interfaz
 * entera y pasarle megas de imagen por JavaScript.
 *
 * El teléfono no guarda nada: lee lo compartido de la app que lo comparte y lo
 * manda. Si la PC no contesta, no queda nada en cola.
 */
class ShareActivity : Activity(), NotesClient.Listener {
    private companion object {
        /** Miniaturas a la vista: el resto se cuenta. */
        const val MAX_THUMBS = 6
        const val THUMB_DP = 64
    }

    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private lateinit var action: Button
    private lateinit var notesBox: LinearLayout
    private lateinit var comment: EditText
    private lateinit var cancel: Button

    private lateinit var pc: PairedPc
    private lateinit var credential: String
    private lateinit var userAgent: String

    /** Las imágenes compartidas: se leen de la app que las comparte, de a una, cuando hace falta. */
    private val images = ArrayList<Uri>()

    /** Ya se leyó cada imagen una vez, al abrir. */
    private var checked = false

    /** Por qué lo compartido no puede ir a ninguna nota, si no puede. */
    private var unusable: String? = null

    private var client: NotesClient? = null
    private var notes: List<ServerMessage.NoteSummary>? = null
    private var uploading = false

    /** Una parte quedó guardada: probar de nuevo la subiría otra vez. */
    private var partlySaved = false
    private var stopObserving: (() -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Orientation.apply(this)
        setContentView(R.layout.activity_share)
        edgeToEdge()
        status = findViewById(R.id.status)
        progress = findViewById(R.id.progress)
        action = findViewById(R.id.action)
        notesBox = findViewById(R.id.notes)
        comment = findViewById(R.id.comment)
        cancel = findViewById(R.id.cancel)
        cancel.setOnClickListener { finish() }

        val store = PcStore(this)
        val paired = store.load()
        val saved = store.credential()
        if (paired == null || saved == null) {
            comment.visibility = View.GONE
            unusable = Texts.problem(this, TunnelProblem.NotPaired)
            showProblem(unusable!!, R.string.share_open_app to ::openApp)
            return
        }
        pc = paired
        credential = saved
        val deviceName = Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME) ?: Build.MODEL
        userAgent = PhoneIdentity.userAgent(BuildConfig.VERSION_NAME, Build.VERSION.RELEASE, deviceName)

        val sharedText = readShared()
        if (images.isEmpty() && sharedText == null && unusable == null) unusable = getString(R.string.share_nothing)
        // El texto que vino va al comentario, a la vista: se edita o se borra antes de guardar.
        sharedText?.let { comment.setText(it) }
        findViewById<TextView>(R.id.summary).apply {
            if (images.isEmpty()) visibility = View.GONE
            else text = resources.getQuantityString(R.plurals.share_images, images.size, images.size)
        }
        checkImages()
        // Conecta, o corta la espera si estaba reintentando. Conectado no hace falta: el aviso fijo diría "Conectando".
        if (unusable == null && Tunnel.status !is TunnelStatus.Connected) TunnelService.start(this)
        render()
    }

    override fun onResume() {
        super.onResume()
        if (::pc.isInitialized) stopObserving = Tunnel.observe(::onTunnel)
    }

    override fun onPause() {
        stopObserving?.invoke()
        stopObserving = null
        super.onPause()
    }

    override fun onDestroy() {
        client?.close()
        client = null
        super.onDestroy()
    }

    // ---- Lo compartido ---------------------------------------------------------------

    /**
     * Las imágenes y el texto del pedido. Lo que no se puede leer con seguridad (un
     * `file://`, algo de la propia app) se dice, no se salta en silencio.
     */
    private fun readShared(): String? {
        val found = LinkedHashSet<Uri>()
        when (intent.action) {
            Intent.ACTION_SEND -> streamExtra()?.let(found::add)
            Intent.ACTION_SEND_MULTIPLE -> streamListExtra()?.let(found::addAll)
        }
        // Algunas apps las mandan sólo en el ClipData, que es además lo que lleva el permiso de lectura.
        intent.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(found::add) }
        for (uri in found) {
            if (SharedItems.acceptsUri(uri.scheme, uri.authority, packageName)) images += uri
            else unusable = getString(R.string.share_error_unreadable)
        }
        return SharedItems.sharedText(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
    }

    // El tipado de la API 33 falla en algunos teléfonos con Android 13: se usa desde la 34, como androidx.
    private fun streamExtra(): Uri? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)

    private fun streamListExtra(): List<Uri>? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)

    /** Hasta un byte más que el tope: con eso ya se sabe que no entra. */
    @Throws(IOException::class)
    private fun readUri(uri: Uri): ByteArray {
        val input = try {
            contentResolver.openInputStream(uri)
        } catch (error: SecurityException) {
            throw IOException(error)
        } ?: throw IOException("sin contenido")
        input.use { stream ->
            val limit = SharedItems.MAX_IMAGE_BYTES + 1
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(64 * 1024)
            while (out.size() < limit) {
                val read = stream.read(buffer, 0, minOf(buffer.size, limit - out.size()))
                if (read < 0) break
                out.write(buffer, 0, read)
            }
            return out.toByteArray()
        }
    }

    /** Cada imagen se lee una vez al abrir: la miniatura, y si alguna no entra se dice antes de elegir la nota. */
    private fun checkImages() {
        if (images.isEmpty() || unusable != null) {
            checked = true
            return
        }
        val size = (THUMB_DP * resources.displayMetrics.density).toInt()
        thread(name = "share-check") {
            val thumbs = ArrayList<Bitmap>()
            var problem: NoteUpload.Problem? = null
            for (uri in images) {
                val bytes = try {
                    readUri(uri)
                } catch (_: IOException) {
                    problem = NoteUpload.Problem.Unreadable
                    break
                }
                problem = NoteUpload.problemOf(bytes)
                if (problem != null) break
                if (thumbs.size < MAX_THUMBS) thumbnail(bytes, size)?.let(thumbs::add)
            }
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                checked = true
                problem?.let { unusable = problemText(it) }
                showThumbs(thumbs)
                render()
            }
        }
    }

    private fun thumbnail(bytes: ByteArray, size: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (minOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= size) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    private fun showThumbs(thumbs: List<Bitmap>) {
        if (thumbs.isEmpty()) return
        val box = findViewById<LinearLayout>(R.id.thumbs)
        val size = (THUMB_DP * resources.displayMetrics.density).toInt()
        val gap = (8 * resources.displayMetrics.density).toInt()
        for (bitmap in thumbs) {
            box.addView(
                ImageView(this).apply {
                    setImageBitmap(bitmap)
                    scaleType = ImageView.ScaleType.CENTER_CROP
                    contentDescription = null
                },
                LinearLayout.LayoutParams(size, size).apply { marginEnd = gap },
            )
        }
        if (images.size > thumbs.size) {
            box.addView(TextView(this).apply {
                text = getString(R.string.share_more, images.size - thumbs.size)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            })
        }
        findViewById<View>(R.id.thumbsScroll).visibility = View.VISIBLE
    }

    // ---- La conexión -------------------------------------------------------------------

    private fun onTunnel(next: TunnelStatus) {
        if (next is TunnelStatus.Connected && client == null && !uploading && unusable == null) openClient()
        render()
    }

    private fun openClient() {
        notes = null
        client = NotesClient(pc.appPort, credential, userAgent, this)
    }

    private fun reconnect() {
        if (Tunnel.status is TunnelStatus.Connected) openClient() else TunnelService.retry(this)
        render()
    }

    override fun onNotes(notes: List<ServerMessage.NoteSummary>) = runOnUiThread {
        this.notes = notes
        render()
    }

    override fun onClosed(notAccepted: Boolean) = runOnUiThread {
        client = null
        notes = null
        // A una subida en curso le llega "sin respuesta" y lo dice ella.
        if (uploading || partlySaved || isDestroyed) return@runOnUiThread
        if (notAccepted) showProblem(Texts.problem(this, TunnelProblem.NotAccepted), R.string.share_open_app to ::openApp)
        else showProblem(getString(R.string.share_connection_lost), R.string.action_retry to ::reconnect)
    }

    // ---- Lo que se ve ---------------------------------------------------------------------

    /** La pantalla según lo que se sabe: lo compartido, la conexión y las notas. */
    private fun render() {
        if (uploading || partlySaved) return
        unusable?.let {
            showProblem(it, if (::pc.isInitialized) null else R.string.share_open_app to ::openApp)
            return
        }
        val tunnel = Tunnel.status
        val list = notes
        when {
            tunnel is TunnelStatus.Blocked -> showProblem(Texts.problem(this, tunnel.problem), R.string.share_open_app to ::openApp)
            client == null && tunnel is TunnelStatus.Waiting ->
                showProblem(Texts.problem(this, tunnel.problem), R.string.action_retry to { TunnelService.retry(this) })
            client == null -> showBusy(getString(R.string.status_connecting, pc.pcName))
            list == null || !checked -> showBusy(getString(R.string.share_loading))
            else -> showNotes(list)
        }
    }

    private fun showNotes(list: List<ServerMessage.NoteSummary>) {
        progress.visibility = View.GONE
        status.visibility = View.GONE
        action.visibility = View.GONE
        notesBox.removeAllViews()
        notesBox.addView(row(getString(R.string.share_new_note), null, accent = true) { pick(null) })
        val now = System.currentTimeMillis()
        val untitled = getString(R.string.share_note_untitled)
        val imageOnly = getString(R.string.share_note_image_only)
        for (note in list.sortedByDescending { it.updatedAt }) {
            val count = if (note.images == 0) getString(R.string.share_no_images)
            else resources.getQuantityString(R.plurals.share_images, note.images, note.images)
            val ago = DateUtils.getRelativeTimeSpanString(note.updatedAt, now, DateUtils.MINUTE_IN_MILLIS)
            notesBox.addView(row(SharedItems.noteTitle(note.text, note.images, untitled, imageOnly), "$count · $ago") { pick(note) })
        }
    }

    private fun row(title: String, meta: String?, accent: Boolean = false, onClick: () -> Unit): View {
        val view = layoutInflater.inflate(R.layout.item_note, notesBox, false)
        view.findViewById<TextView>(R.id.noteTitle).apply {
            text = title
            if (accent) setTextColor(accentColor())
        }
        view.findViewById<TextView>(R.id.noteMeta).apply {
            if (meta == null) visibility = View.GONE else text = meta
        }
        view.setOnClickListener { onClick() }
        return view
    }

    private fun accentColor(): Int {
        val attributes = theme.obtainStyledAttributes(intArrayOf(android.R.attr.colorAccent))
        return attributes.getColor(0, 0).also { attributes.recycle() }
    }

    private fun showBusy(text: String) {
        progress.visibility = View.VISIBLE
        status.visibility = View.VISIBLE
        status.text = text
        action.visibility = View.GONE
    }

    /** Algo impide seguir: el texto, y la acción que lo destraba si hay una. Sin notas a la vista. */
    private fun showProblem(text: String, button: Pair<Int, () -> Unit>?) {
        progress.visibility = View.GONE
        status.visibility = View.VISIBLE
        status.text = text
        notesBox.removeAllViews()
        if (button == null) {
            action.visibility = View.GONE
        } else {
            action.visibility = View.VISIBLE
            action.setText(button.first)
            action.setOnClickListener { button.second() }
        }
    }

    /** Lo que salió mal con la nota elegida: las notas siguen a la vista para probar de nuevo. */
    private fun showError(text: String) {
        progress.visibility = View.GONE
        status.visibility = View.VISIBLE
        status.text = text
        action.visibility = View.GONE
    }

    private fun setEnabled(enabled: Boolean) {
        comment.isEnabled = enabled
        for (index in 0 until notesBox.childCount) notesBox.getChildAt(index).isEnabled = enabled
    }

    private fun openApp() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    // ---- Subir -------------------------------------------------------------------------

    private fun pick(note: ServerMessage.NoteSummary?) {
        val channel = client ?: return
        val list = notes ?: return
        if (uploading) return
        when (SharedItems.room(note?.images, images.size, list.size)) {
            SharedItems.Room.TooManyImages -> return showError(getString(R.string.share_too_many_images, SharedItems.MAX_NOTE_IMAGES))
            SharedItems.Room.TooManyNotes -> return showError(getString(R.string.share_too_many_notes, SharedItems.MAX_NOTES))
            null -> Unit
        }
        uploading = true
        setEnabled(false)
        showBusy(if (images.isEmpty()) getString(R.string.share_saving) else getString(R.string.share_uploading, 1, images.size))
        val addition = comment.text.toString()
        val sources = images.map { uri -> SharedImage { readUri(uri) } }
        thread(name = "share-upload") {
            val outcome = NoteUpload(channel).run(note, SharedItems.newNoteId(), addition, sources) { index ->
                runOnUiThread { status.text = getString(R.string.share_uploading, index, sources.size) }
            }
            runOnUiThread { done(outcome) }
        }
    }

    private fun done(outcome: NoteUpload.Outcome) {
        uploading = false
        if (isDestroyed) return
        when (outcome) {
            is NoteUpload.Outcome.Saved -> {
                val title = SharedItems.noteTitle(
                    outcome.text,
                    outcome.images,
                    getString(R.string.share_note_untitled),
                    getString(R.string.share_note_image_only),
                )
                Toast.makeText(this, getString(R.string.share_saved, title), Toast.LENGTH_LONG).show()
                finish()
            }
            is NoteUpload.Outcome.Failed -> {
                val reason = problemText(outcome.problem)
                when {
                    outcome.saved > 0 -> {
                        partlySaved = true
                        comment.isEnabled = false
                        showProblem(reason + "\n" + getString(R.string.share_saved_partly, outcome.saved, outcome.total), null)
                        cancel.setText(R.string.share_close)
                    }
                    client == null -> showProblem(reason, R.string.action_retry to ::reconnect)
                    else -> {
                        setEnabled(true)
                        showError(reason)
                    }
                }
            }
        }
    }

    private fun problemText(problem: NoteUpload.Problem): String = when (problem) {
        NoteUpload.Problem.NoAnswer -> getString(R.string.share_error_no_answer)
        NoteUpload.Problem.Unreadable -> getString(R.string.share_error_unreadable)
        NoteUpload.Problem.NotAnImage -> getString(R.string.share_error_format)
        NoteUpload.Problem.TooLarge -> getString(R.string.share_error_too_large, SharedItems.MAX_IMAGE_BYTES / 1024 / 1024)
        is NoteUpload.Problem.Server -> {
            val max = problem.params["max"]?.toIntOrNull()
            when (problem.key) {
                "noteGone" -> getString(R.string.share_error_note_gone)
                "noteImagesMax" -> getString(R.string.share_too_many_images, max ?: SharedItems.MAX_NOTE_IMAGES)
                "notesMax" -> getString(R.string.share_too_many_notes, max ?: SharedItems.MAX_NOTES)
                "noteTooLong" -> getString(R.string.share_error_too_long, max ?: 0)
                "imageTooLarge", "imageUnknownFormat", "imageTypeUnsupported", "imageEmpty" -> getString(R.string.share_error_image_rejected)
                else -> getString(R.string.share_error_generic)
            }
        }
    }
}
