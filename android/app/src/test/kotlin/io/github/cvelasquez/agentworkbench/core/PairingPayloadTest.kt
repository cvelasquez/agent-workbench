package io.github.cvelasquez.agentworkbench.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class PairingPayloadTest {
    /** Lo que arma el servidor (`phonePairingPayload`), copiado de la salida de check-remote-access.mjs. */
    private val fromServer =
        "agentworkbench://pair?v=1&n=PC+Ana&h=192.168.1.20%2C10.0.0.5&p=22&u=Ana+P%C3%A9rez&a=24837&c=K7QMX2RD&k=nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A"

    @Test
    fun `lee lo que arma el servidor, con espacios y tildes`() {
        val payload = PairingPayload.parse(fromServer)
        assertNotNull(payload)
        payload!!
        assertEquals("PC Ana", payload.pcName)
        assertEquals(listOf("192.168.1.20", "10.0.0.5"), payload.hosts)
        assertEquals(22, payload.sshPort)
        assertEquals("Ana Pérez", payload.user)
        assertEquals(24837, payload.appPort)
        assertEquals("K7QMX2RD", payload.code)
        assertEquals(
            "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
            payload.seed.joinToString("") { "%02x".format(it) },
        )
    }

    @Test
    fun `acepta espacios alrededor y el código en minúsculas`() {
        assertEquals("K7QMX2RD", PairingPayload.parse("  " + fromServer.replace("c=K7QMX2RD", "c=k7qmx2rd") + "\n")?.code)
    }

    @Test
    fun `otra versión, otro prefijo o algo que no es un QR de la app no se leen`() {
        assertNull(PairingPayload.parse(fromServer.replace("v=1", "v=2")))
        assertNull(PairingPayload.parse(fromServer.replace("agentworkbench://pair?", "https://example.com/?")))
        assertNull(PairingPayload.parse("hola"))
        assertNull(PairingPayload.parse(""))
    }

    @Test
    fun `cada campo se valida por su forma`() {
        assertNull("semilla corta", PairingPayload.parse(fromServer.replace(Regex("k=[^&]+"), "k=AAAA")))
        assertNull("código con una letra que el alfabeto no tiene", PairingPayload.parse(fromServer.replace("c=K7QMX2RD", "c=K7QMX2R0")))
        assertNull("sin direcciones", PairingPayload.parse(fromServer.replace(Regex("h=[^&]+"), "h=")))
        assertNull("una dirección con un espacio", PairingPayload.parse(fromServer.replace(Regex("h=[^&]+"), "h=evil+host")))
        assertNull("una dirección con signos", PairingPayload.parse(fromServer.replace(Regex("h=[^&]+"), "h=a%3Brm")))
        assertNull("puerto de la app fuera de rango", PairingPayload.parse(fromServer.replace("a=24837", "a=80")))
        assertNull("puerto SSH que no es un número", PairingPayload.parse(fromServer.replace("p=22", "p=x")))
        assertNull("sin usuario", PairingPayload.parse(fromServer.replace(Regex("u=[^&]+"), "u=")))
    }

    @Test
    fun `lo que se imprime no lleva la semilla`() {
        val text = PairingPayload.parse(fromServer).toString()
        assertFalse(text.contains("nWGxne"))
        assertFalse(text.contains("9d61b1"))
    }
}
