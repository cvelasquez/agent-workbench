package io.github.cvelasquez.agentworkbench.core

import io.github.cvelasquez.agentworkbench.watch.NoteUpload
import io.github.cvelasquez.agentworkbench.watch.NotesChannel
import io.github.cvelasquez.agentworkbench.watch.SharedImage
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException
import java.util.ArrayDeque

/** La subida a una nota (hito 50): el orden de los mensajes y qué se hace con cada respuesta. */
class NoteUploadTest {
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)

    /** Una PC de mentira: contesta a cada mensaje como la de verdad, salvo lo que se le pida. */
    private class FakePc(private val failOn: Set<Int> = emptySet(), private val silent: Boolean = false) : NotesChannel {
        val sent = mutableListOf<JSONObject>()
        private val replies = ArrayDeque<ServerMessage>()
        private var images = 0

        override fun send(text: String): Boolean {
            val json = JSONObject(text)
            sent += json
            if (silent) return true
            when (json.getString("type")) {
                "notes.addImage" -> {
                    images++
                    replies += if (images in failOn) ServerMessage.Failure("notes-failed", "noteImagesMax", mapOf("max" to "20"))
                    else ServerMessage.NoteImageStored("img-$images")
                }
                // Como `notes.image` de la PC con un id que no es de ninguna nota: contesta con data null.
                "notes.image" -> replies += ServerMessage.NoteImageStored(json.getString("imageId"))
            }
            return true
        }

        override fun nextReply(timeoutMs: Long): ServerMessage? = replies.pollFirst()

        val types get() = sent.map { it.getString("type") }
    }

    private fun upload(pc: FakePc) = NoteUpload(pc) { "share-barrera" }

    @Test
    fun `una nota nueva con comentario y dos imágenes`() {
        val pc = FakePc()
        val result = upload(pc).run(target = null, newNoteId = "n-1", addition = "el botón se corta", images = listOf(SharedImage { png }, SharedImage { png })) {}
        assertEquals(NoteUpload.Outcome.Saved("n-1", "el botón se corta", 2), result)
        assertEquals(listOf("notes.create", "notes.update", "notes.image", "notes.addImage", "notes.addImage"), pc.types)
        assertEquals("el botón se corta", pc.sent[1].getString("text"))
        assertEquals("share-barrera", pc.sent[2].getString("imageId"))
    }

    @Test
    fun `en una nota que existe, sin texto, sólo las imágenes`() {
        val pc = FakePc()
        val note = ServerMessage.NoteSummary("n-9", "Bugs", 3, 1)
        val result = upload(pc).run(target = note, newNoteId = "sin-usar", addition = "  ", images = listOf(SharedImage { png })) {}
        assertEquals(NoteUpload.Outcome.Saved("n-9", "Bugs", 4), result)
        assertEquals(listOf("notes.addImage"), pc.types)
        assertEquals("n-9", pc.sent[0].getString("noteId"))
    }

    @Test
    fun `el comentario se suma al texto que ya tenía la nota`() {
        val pc = FakePc()
        val note = ServerMessage.NoteSummary("n-9", "Bugs\n", 0, 1)
        upload(pc).run(target = note, newNoteId = "sin-usar", addition = "otro más", images = emptyList()) {}
        assertEquals(listOf("notes.update", "notes.image"), pc.types)
        assertEquals("Bugs\n\notro más", pc.sent[0].getString("text"))
    }

    @Test
    fun `si la PC rechaza una imagen, se para y dice cuántas quedaron`() {
        val pc = FakePc(failOn = setOf(2))
        val result = upload(pc).run(target = null, newNoteId = "n-1", addition = "", images = listOf(SharedImage { png }, SharedImage { png }, SharedImage { png })) {}
        assertEquals(NoteUpload.Outcome.Failed(saved = 1, total = 3, problem = NoteUpload.Problem.Server("noteImagesMax", mapOf("max" to "20"))), result)
        assertEquals("la tercera no se manda", 2, pc.types.count { it == "notes.addImage" })
    }

    @Test
    fun `sin respuesta de la PC no se da nada por guardado`() {
        val result = upload(FakePc(silent = true)).run(target = null, newNoteId = "n-1", addition = "hola", images = listOf(SharedImage { png })) {}
        assertEquals(NoteUpload.Outcome.Failed(saved = 0, total = 1, problem = NoteUpload.Problem.NoAnswer), result)
    }

    @Test
    fun `lo que no se puede leer, o no es una imagen que entre, se dice antes de mandar nada`() {
        val cases = listOf(
            SharedImage { throw IOException("sin permiso") } to NoteUpload.Problem.Unreadable,
            SharedImage { "____ftypheic____".toByteArray() } to NoteUpload.Problem.NotAnImage,
            SharedImage { ByteArray(SharedItems.MAX_IMAGE_BYTES + 1).also { png.copyInto(it) } } to NoteUpload.Problem.TooLarge,
        )
        for ((bad, problem) in cases) {
            val pc = FakePc()
            // La mala es la segunda: tampoco la primera se sube, ni se crea una nota vacía.
            val result = upload(pc).run(target = null, newNoteId = "n-1", addition = "hola", images = listOf(SharedImage { png }, bad)) {}
            assertEquals(NoteUpload.Outcome.Failed(saved = 0, total = 2, problem = problem), result)
            assertEquals(emptyList<String>(), pc.types)
        }
    }

    @Test
    fun `avisa el progreso, una imagen por vez`() {
        val seen = mutableListOf<Int>()
        upload(FakePc()).run(target = null, newNoteId = "n-1", addition = "", images = listOf(SharedImage { png }, SharedImage { png })) { seen += it }
        assertEquals(listOf(1, 2), seen)
    }
}
