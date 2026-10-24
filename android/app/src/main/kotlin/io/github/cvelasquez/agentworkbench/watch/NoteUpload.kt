package io.github.cvelasquez.agentworkbench.watch

import io.github.cvelasquez.agentworkbench.core.ServerMessage
import io.github.cvelasquez.agentworkbench.core.SharedItems
import org.json.JSONObject
import java.io.IOException
import java.util.Base64
import java.util.UUID

/** Por dónde habla la subida con la PC: el WebSocket de `NotesClient`, o uno falso en las pruebas. */
interface NotesChannel {
    /** false si la conexión ya no acepta mensajes. */
    fun send(text: String): Boolean

    /** La próxima respuesta a esta conexión, un acuse de imagen o un error; null si no llegó a tiempo o se cerró. */
    fun nextReply(timeoutMs: Long): ServerMessage?
}

/**
 * Una imagen compartida. Se lee recién cuando hace falta, de a una: todas juntas
 * podrían pesar cientos de MB.
 */
fun interface SharedImage {
    /** Hasta `MAX_IMAGE_BYTES + 1` bytes: con uno de más ya se sabe que no entra. */
    @Throws(IOException::class)
    fun read(): ByteArray
}

/**
 * Lo compartido, a una nota (hito 50, §15.12): crearla si es nueva, sumarle el
 * texto y subir cada imagen esperando su acuse, en ese orden.
 *
 * Nada se manda hasta saber que todas las imágenes se pueden leer y entran: así una
 * mala no deja una nota vacía ni la mitad de las capturas.
 */
class NoteUpload(
    private val channel: NotesChannel,
    private val barrierId: () -> String = { "share-" + UUID.randomUUID() },
) {
    sealed class Outcome {
        /** Guardado: el texto y la cantidad de imágenes con que quedó la nota, para nombrarla. */
        data class Saved(val noteId: String, val text: String, val images: Int) : Outcome()
        data class Failed(val saved: Int, val total: Int, val problem: Problem) : Outcome()
    }

    sealed class Problem {
        /** La PC dijo que no, con la clave de su texto (§6.23). */
        data class Server(val key: String, val params: Map<String, String>) : Problem()
        data object NoAnswer : Problem()
        data object Unreadable : Problem()
        data object NotAnImage : Problem()
        data object TooLarge : Problem()
    }

    /**
     * Sube a `target`, o a una nota nueva con `newNoteId` si es null. Bloquea hasta
     * terminar: se llama fuera del hilo principal. `progress` recibe el número de la
     * imagen que se está subiendo.
     */
    fun run(
        target: ServerMessage.NoteSummary?,
        newNoteId: String,
        addition: String,
        images: List<SharedImage>,
        progress: (Int) -> Unit,
    ): Outcome {
        val total = images.size
        for (image in images) checkImage(image)?.let { return Outcome.Failed(0, total, it) }

        val noteId = target?.noteId ?: newNoteId
        val before = target?.text.orEmpty()
        val text = SharedItems.appendText(before, addition)
        var unanswered = false
        if (target == null) {
            if (!channel.send(SharedItems.createNote(noteId))) return Outcome.Failed(0, total, Problem.NoAnswer)
            unanswered = true
        }
        if (text != before) {
            if (!channel.send(SharedItems.updateNote(noteId, text))) return Outcome.Failed(0, total, Problem.NoAnswer)
            unanswered = true
        }
        if (unanswered) awaitBarrier()?.let { return Outcome.Failed(0, total, it) }

        images.forEachIndexed { index, image ->
            progress(index + 1)
            val bytes = try {
                image.read()
            } catch (_: IOException) {
                return Outcome.Failed(index, total, Problem.Unreadable)
            }
            val type = SharedItems.imageType(bytes) ?: return Outcome.Failed(index, total, Problem.NotAnImage)
            if (bytes.size > SharedItems.MAX_IMAGE_BYTES) return Outcome.Failed(index, total, Problem.TooLarge)
            val message = SharedItems.addImage(noteId, type, Base64.getEncoder().encodeToString(bytes))
            if (!channel.send(message)) return Outcome.Failed(index, total, Problem.NoAnswer)
            when (val reply = channel.nextReply(IMAGE_TIMEOUT_MS)) {
                is ServerMessage.NoteImageStored -> Unit
                is ServerMessage.Failure -> return Outcome.Failed(index, total, Problem.Server(reply.key, reply.params))
                else -> return Outcome.Failed(index, total, Problem.NoAnswer)
            }
        }
        return Outcome.Saved(noteId, text, (target?.images ?: 0) + total)
    }

    private fun checkImage(image: SharedImage): Problem? {
        val bytes = try {
            image.read()
        } catch (_: IOException) {
            return Problem.Unreadable
        }
        return problemOf(bytes)
    }

    /**
     * Crear una nota y cambiarle el texto no tienen acuse: la PC sólo contesta si
     * algo falla. Pedir una imagen que no es de ninguna nota (`notes.image`) sí tiene
     * respuesta, y la PC atiende cada conexión en orden: cuando llega la respuesta, lo
     * anterior ya pasó, y si falló, su error llegó antes.
     */
    private fun awaitBarrier(): Problem? {
        val id = barrierId()
        if (!channel.send(JSONObject().put("type", "notes.image").put("imageId", id).toString())) return Problem.NoAnswer
        while (true) {
            when (val reply = channel.nextReply(BARRIER_TIMEOUT_MS)) {
                is ServerMessage.NoteImageStored -> if (reply.imageId == id) return null
                is ServerMessage.Failure -> return Problem.Server(reply.key, reply.params)
                else -> return Problem.NoAnswer
            }
        }
    }

    companion object {
        /** Por qué una imagen no entra en una nota, o null si entra. Lo usa también la pantalla, al abrirse. */
        fun problemOf(bytes: ByteArray): Problem? = when {
            SharedItems.imageType(bytes) == null -> Problem.NotAnImage
            bytes.size > SharedItems.MAX_IMAGE_BYTES -> Problem.TooLarge
            else -> null
        }

        /** Una imagen de 11 MB por el wifi de la casa tarda segundos; un minuto ya es que no va a llegar. */
        private const val IMAGE_TIMEOUT_MS = 60_000L
        private const val BARRIER_TIMEOUT_MS = 15_000L
    }
}
