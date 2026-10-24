package io.github.cvelasquez.agentworkbench.core

import org.json.JSONObject
import java.util.UUID

/**
 * Compartir a una nota (hito 50, §15.12): lo que se decide sin Android ni la red.
 *
 * El teléfono le manda a la PC lo mismo que la web al pegar una imagen en una nota
 * (`notes.create`, `notes.update`, `notes.addImage` de `shared/src/protocol.ts`), y
 * mira antes lo que la PC rechazaría: así no sube megas para que le digan que no.
 */
object SharedItems {
    /**
     * Hasta 11 MB por imagen. La PC acepta 12 MiB (`MAX_SUBMIT_IMAGE_BYTES`), pero
     * OkHttp cierra el WebSocket si un mensaje no entra en su cola de 16 MiB, y una
     * imagen de 12 MiB en base64 ya ocupa eso. Una captura pesa de 1 a 3 MB.
     */
    const val MAX_IMAGE_BYTES = 11 * 1024 * 1024

    /** Los topes de las notas (`shared/src/notes.ts`). */
    const val MAX_NOTE_IMAGES = 20
    const val MAX_NOTES = 100

    /** El título, como `noteTitle` de la web: hasta 40 caracteres de la primera línea. */
    private const val TITLE_CHARS = 40

    /**
     * El tipo de una imagen por sus primeros bytes, con la misma lista que la PC
     * (`image-signature.ts`): PNG, JPEG, GIF y WebP. null si no es ninguna.
     */
    fun imageType(head: ByteArray): String? {
        fun ascii(from: Int, text: String) =
            head.size >= from + text.length && text.indices.all { head[from + it] == text[it].code.toByte() }
        return when {
            head.size > 8 && head.copyOf(8).contentEquals(PNG) -> "image/png"
            head.size > 3 && head[0] == 0xff.toByte() && head[1] == 0xd8.toByte() && head[2] == 0xff.toByte() -> "image/jpeg"
            head.size > 6 && ascii(0, "GIF8") -> "image/gif"
            head.size > 12 && ascii(0, "RIFF") && ascii(8, "WEBP") -> "image/webp"
            else -> null
        }
    }

    private val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

    /**
     * Qué dirección se lee. La pantalla de compartir la puede abrir cualquier app con
     * lo que quiera adentro: un `file://` o un `content://` de la propia app podrían
     * apuntar a sus archivos privados (la llave cifrada). Sólo `content://` de otra.
     */
    fun acceptsUri(scheme: String?, authority: String?, ownPackage: String): Boolean =
        scheme == "content" && !authority.isNullOrEmpty() && !authority.startsWith(ownPackage)

    fun noteTitle(text: String, images: Int, untitled: String, imageOnly: String): String {
        val line = text.split('\n').map { it.trim() }.firstOrNull { it.isNotEmpty() }
            ?: return if (images > 0) imageOnly else untitled
        return if (line.length > TITLE_CHARS) line.take(TITLE_CHARS) + "…" else line
    }

    /** El comentario va al final de la nota, después de una línea en blanco. */
    fun appendText(current: String, addition: String): String {
        val extra = addition.trim()
        if (extra.isEmpty()) return current
        val base = current.trimEnd()
        return if (base.isEmpty()) extra else "$base\n\n$extra"
    }

    /** Lo que trae un texto compartido: el asunto (el título de una página) y el texto, sin repetir. */
    fun sharedText(subject: String?, text: String?): String? {
        val s = subject?.trim().orEmpty()
        val t = text?.trim().orEmpty()
        return when {
            s.isEmpty() && t.isEmpty() -> null
            s.isEmpty() -> t
            t.isEmpty() || t.contains(s) -> t.ifEmpty { s }
            else -> "$s\n$t"
        }
    }

    enum class Room { TooManyImages, TooManyNotes }

    /**
     * Si lo compartido entra: en una nota nueva (`existingImages` null) o en una que
     * ya tiene esas imágenes. null si entra.
     */
    fun room(existingImages: Int?, adding: Int, notes: Int): Room? = when {
        (existingImages ?: 0) + adding > MAX_NOTE_IMAGES -> Room.TooManyImages
        existingImages == null && notes >= MAX_NOTES -> Room.TooManyNotes
        else -> null
    }

    /** El id de una nota nueva lo pone el cliente (`isValidNoteId`: letras, números y guiones). */
    fun newNoteId(): String = UUID.randomUUID().toString()

    fun createNote(noteId: String): String = JSONObject().put("type", "notes.create").put("noteId", noteId).toString()

    fun updateNote(noteId: String, text: String): String =
        JSONObject().put("type", "notes.update").put("noteId", noteId).put("text", text).toString()

    /**
     * Armado a mano y no con org.json: son hasta 15 MB de base64, que no lleva nada
     * que escapar, y org.json los copiaría dos veces más. El id (el de una nota que
     * existe lo pone la PC) y el tipo van escapados igual.
     */
    fun addImage(noteId: String, mediaType: String, base64: String): String =
        "{\"type\":\"notes.addImage\",\"noteId\":${JSONObject.quote(noteId)}," +
            "\"image\":{\"mediaType\":${JSONObject.quote(mediaType)},\"data\":\"$base64\"}}"
}
