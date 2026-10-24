package io.github.cvelasquez.agentworkbench.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Compartir a una nota (hito 50): lo que se decide sin tocar Android ni la red. */
class SharedItemsTest {
    private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }
    private fun ascii(text: String) = text.toByteArray(Charsets.US_ASCII)

    @Test
    fun `una imagen se reconoce por sus bytes, con la misma lista que la PC`() {
        assertEquals("image/png", SharedItems.imageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)))
        assertEquals("image/jpeg", SharedItems.imageType(bytes(0xff, 0xd8, 0xff, 0xe0)))
        assertEquals("image/gif", SharedItems.imageType(ascii("GIF89a__")))
        assertEquals("image/webp", SharedItems.imageType(ascii("RIFF____WEBPVP8 ")))
        assertNull("HEIC: no entra en una nota", SharedItems.imageType(ascii("____ftypheic____")))
        assertNull("un texto", SharedItems.imageType(ascii("<?xml version")))
        assertNull("muy corto", SharedItems.imageType(bytes(0x89, 0x50)))
        assertNull("vacío", SharedItems.imageType(ByteArray(0)))
    }

    @Test
    fun `el tope del teléfono deja una imagen en base64 dentro de los 16 MiB del canal`() {
        val base64 = (SharedItems.MAX_IMAGE_BYTES + 2) / 3 * 4
        assertTrue(base64 + 200 < 16L * 1024 * 1024)
        assertTrue(SharedItems.MAX_IMAGE_BYTES < 12 * 1024 * 1024)
    }

    @Test
    fun `sólo se lee lo que llega por content y no es de la propia app`() {
        val own = "io.github.cvelasquez.agentworkbench"
        assertTrue(SharedItems.acceptsUri("content", "media", own))
        assertTrue(SharedItems.acceptsUri("content", "com.miui.gallery.open", own))
        assertFalse("un archivo suelto podría ser uno privado de la app", SharedItems.acceptsUri("file", null, own))
        assertFalse(SharedItems.acceptsUri("content", "io.github.cvelasquez.agentworkbench.files", own))
        assertFalse(SharedItems.acceptsUri("content", "io.github.cvelasquez.agentworkbench.dev.files", own))
        assertFalse(SharedItems.acceptsUri("content", null, own))
        assertFalse(SharedItems.acceptsUri("http", "example.com", own))
    }

    @Test
    fun `el título de una nota es el de la web`() {
        assertEquals("Bugs del checkout", SharedItems.noteTitle("\n  Bugs del checkout  \nmás", 0, "Nota", "Imagen"))
        assertEquals("a".repeat(40) + "…", SharedItems.noteTitle("a".repeat(41), 0, "Nota", "Imagen"))
        assertEquals("a".repeat(40), SharedItems.noteTitle("a".repeat(40), 0, "Nota", "Imagen"))
        assertEquals("Imagen", SharedItems.noteTitle(" \n ", 2, "Nota", "Imagen"))
        assertEquals("Nota", SharedItems.noteTitle("", 0, "Nota", "Imagen"))
    }

    @Test
    fun `el comentario va al final de la nota, separado por una línea en blanco`() {
        assertEquals("el botón se corta", SharedItems.appendText("", "el botón se corta"))
        assertEquals("Bugs\n\nel botón se corta", SharedItems.appendText("Bugs\n\n\n", "el botón se corta"))
        assertEquals("sin nada que agregar, igual", "Bugs\n", SharedItems.appendText("Bugs\n", "  "))
    }

    @Test
    fun `un texto compartido junta el asunto y el texto, sin repetir`() {
        assertEquals("https://example.com/a", SharedItems.sharedText(null, "https://example.com/a"))
        assertEquals("Una página\nhttps://example.com/a", SharedItems.sharedText("Una página", "https://example.com/a"))
        assertEquals("https://example.com/a", SharedItems.sharedText("https://example.com/a", "https://example.com/a"))
        assertEquals("Sólo asunto", SharedItems.sharedText("Sólo asunto", null))
        assertNull(SharedItems.sharedText(" ", "\n"))
        assertNull(SharedItems.sharedText(null, null))
    }

    @Test
    fun `antes de subir se mira si entra, con los topes de las notas`() {
        assertNull("una nota nueva con 3", SharedItems.room(existingImages = null, adding = 3, notes = 10))
        assertNull("una que tiene 17 y se suman 3", SharedItems.room(existingImages = 17, adding = 3, notes = 10))
        assertEquals(SharedItems.Room.TooManyImages, SharedItems.room(existingImages = 18, adding = 3, notes = 10))
        assertEquals(SharedItems.Room.TooManyImages, SharedItems.room(existingImages = null, adding = 21, notes = 10))
        assertEquals(SharedItems.Room.TooManyNotes, SharedItems.room(existingImages = null, adding = 1, notes = 100))
        assertNull("en una que ya existe no importa cuántas notas hay", SharedItems.room(existingImages = 0, adding = 1, notes = 100))
    }

    @Test
    fun `los mensajes a la PC tienen la forma del protocolo`() {
        val create = JSONObject(SharedItems.createNote("n-1"))
        assertEquals("notes.create", create.getString("type"))
        assertEquals("n-1", create.getString("noteId"))

        val update = JSONObject(SharedItems.updateNote("n-1", "línea \"1\"\n</script>"))
        assertEquals("notes.update", update.getString("type"))
        assertEquals("línea \"1\"\n</script>", update.getString("text"))

        // La imagen se arma a mano, sin pasar megas por org.json: el base64 no lleva nada que escapar.
        val image = JSONObject(SharedItems.addImage("n-1", "image/png", "iVBORw0KGgo+/="))
        assertEquals("notes.addImage", image.getString("type"))
        assertEquals("n-1", image.getString("noteId"))
        assertEquals("image/png", image.getJSONObject("image").getString("mediaType"))
        assertEquals("iVBORw0KGgo+/=", image.getJSONObject("image").getString("data"))
        // Un id con comillas (la PC no los da, pero viene de ella) no rompe el mensaje.
        assertEquals("a\"b", JSONObject(SharedItems.addImage("a\"b", "image/png", "AAAA")).getString("noteId"))
    }

    @Test
    fun `el id de una nota nueva tiene la forma que acepta la PC`() {
        val id = SharedItems.newNoteId()
        assertTrue(id, Regex("^[a-zA-Z0-9-]{1,64}$").matches(id))
    }
}
