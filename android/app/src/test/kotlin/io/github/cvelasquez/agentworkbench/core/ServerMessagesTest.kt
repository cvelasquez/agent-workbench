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
