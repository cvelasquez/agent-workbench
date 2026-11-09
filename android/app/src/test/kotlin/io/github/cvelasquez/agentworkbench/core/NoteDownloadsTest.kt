package io.github.cvelasquez.agentworkbench.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException

class NoteDownloadsTest {
    @Test
    fun `acepta solo adjuntos locales por id y sanea el nombre sugerido`() {
        assertEquals(NoteDownloads.Target("a-1", "voz.wav"), NoteDownloads.targetOf("http://127.0.0.1:3000/api/notes/files/a-1?name=carpeta%2Fvoz.wav", 3000))
        for (url in listOf("https://127.0.0.1:3000/api/notes/files/a", "http://example.com:3000/api/notes/files/a", "http://127.0.0.1:3001/api/notes/files/a", "http://user@127.0.0.1:3000/api/notes/files/a", "http://127.0.0.1:3000/api/notes/files/../a", "http://127.0.0.1:3000/api/notes/files/%61")) {
            assertNull(url, NoteDownloads.targetOf(url, 3000))
        }
    }

    @Test
    fun `admite diez MiB y rechaza un byte de más`() {
        assertEquals(SharedItems.MAX_FILE_BYTES, NoteDownloads.read(ByteArrayInputStream(ByteArray(SharedItems.MAX_FILE_BYTES))).size)
        assertThrows(IOException::class.java) { NoteDownloads.read(ByteArrayInputStream(ByteArray(SharedItems.MAX_FILE_BYTES + 1))) }
    }
}
