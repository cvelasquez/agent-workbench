package io.github.cvelasquez.agentworkbench.core

import org.junit.Assert.assertEquals
import org.junit.Test

class ServerMessagesTest {
    @Test
    fun `hello, la lista de pestañas y la actividad, como las manda el servidor`() {
        assertEquals(
            ServerMessage.Hello(8, true),
            ServerMessage.parse("""{"type":"hello","protocolVersion":8,"agents":[],"defaultAgent":null,"platform":"win32","defaultCwd":"C:\\","shellName":"PowerShell","remoteClient":true}"""),
        )
        val list = ServerMessage.parse(
            """{"type":"terminal.list","terminals":[{"terminalId":"t1","kind":"agent","cwd":"D:\\Proyectos\\Mi App","agent":"claude-code","sessionId":"s","label":"","resumed":false,"createdAt":1,"alive":true,"exitCode":null,"sleeping":false},{"terminalId":"t2","cwd":"/home/ana/web","label":"Backend"}],"order":["t1","t2"]}""",
        ) as ServerMessage.TerminalList
        assertEquals(listOf("Mi App", "Backend"), list.terminals.map { it.tabName })
        assertEquals(ServerMessage.Activity("t1", "waiting"), ServerMessage.parse("""{"type":"terminal.activity","terminalId":"t1","activity":"waiting"}"""))
        assertEquals(ServerMessage.Closed("t2"), ServerMessage.parse("""{"type":"terminal.closed","terminalId":"t2"}"""))
    }

    @Test
    fun `la lista de notas, el acuse de una imagen y los errores, para compartir a una nota`() {
        val list = ServerMessage.parse(
            """{"type":"notes.list","notes":[{"noteId":"n1","text":"Bugs\nmás","images":[{"imageId":"i1","mediaType":"image/png","bytes":10},{"imageId":"i2","mediaType":"image/jpeg","bytes":20}],"createdAt":1,"updatedAt":5},{"noteId":"n2","text":"","images":[],"createdAt":2,"updatedAt":3},{"text":"sin id","images":[]}]}""",
        )
        assertEquals(
            ServerMessage.NotesList(listOf(ServerMessage.NoteSummary("n1", "Bugs\nmás", 2, 5), ServerMessage.NoteSummary("n2", "", 0, 3))),
            list,
        )
        // La PC le devuelve los bytes al que subió la imagen: se reconoce sin leer los megas.
        val data = "A".repeat(200_000)
        assertEquals(
            ServerMessage.NoteImageStored("4b8e"),
            ServerMessage.parse("""{"type":"notes.imageData","imageId":"4b8e","mediaType":"image/png","data":"$data"}"""),
        )
        assertEquals(
            ServerMessage.Failure("notes-failed", "noteImagesMax", mapOf("max" to "20")),
            ServerMessage.parse("""{"type":"error","code":"notes-failed","text":{"key":"noteImagesMax","params":{"max":20}}}"""),
        )
        assertEquals(ServerMessage.Failure("internal", "", emptyMap()), ServerMessage.parse("""{"type":"error","code":"internal"}"""))
    }

    @Test
    fun `lo demás, o lo que no se entiende, se ignora`() {
        assertEquals(ServerMessage.Other, ServerMessage.parse("""{"type":"terminal.output","terminalId":"t1","data":"hola"}"""))
        assertEquals(ServerMessage.Other, ServerMessage.parse("""{"type":"terminal.activity","terminalId":"","activity":"busy"}"""))
        assertEquals(ServerMessage.Other, ServerMessage.parse("no es json"))
        assertEquals(ServerMessage.Other, ServerMessage.parse("[]"))
    }

    @Test
    fun `el nombre de una pestaña es su etiqueta, o la última carpeta`() {
        assertEquals("Backend", ServerMessage.tabName("Backend", "D:\\x"))
        assertEquals("Mi App", ServerMessage.tabName("", "D:\\Proyectos\\Mi App\\"))
        assertEquals("mi-app", ServerMessage.tabName("", "/home/ana/mi-app"))
        assertEquals("", ServerMessage.tabName("", ""))
    }

    @Test
    fun `el aviso nombra el proyecto de la pestaña y la PC, aunque la pestaña tenga otro nombre`() {
        val renamed = ServerMessage.Terminal("t2", "Backend", "D:\\Proyectos\\Mi App\\")
        assertEquals("Mi App", renamed.projectName)
        assertEquals("Mi App · Laptop", ServerMessage.noticeBody(renamed.projectName, "Laptop"))
        assertEquals("web", ServerMessage.Terminal("t3", "", "/home/ana/web").projectName)
        // Sin carpeta (no debería pasar), sólo la PC: nada de un "· Laptop" suelto.
        assertEquals("Laptop", ServerMessage.noticeBody("", "Laptop"))
    }
}
