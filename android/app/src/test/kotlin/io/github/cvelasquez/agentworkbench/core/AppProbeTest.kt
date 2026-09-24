package io.github.cvelasquez.agentworkbench.core

import io.github.cvelasquez.agentworkbench.tunnel.AppProbe
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Los pedidos de `AppProbe` van por un túnel que muere y renace: el de antes de
 * "Olvidar", el del emparejamiento, el del servicio. Una conexión guardada para
 * reusar quedaba enganchada al reenviador de un túnel muerto, y el pedido
 * siguiente fallaba ("no contesta") aunque la PC estuviera ahí (24-09-2026).
 */
class AppProbeTest {
    /**
     * Un "reenviador" mínimo: contesta cada pedido con `status`, promete mantener la
     * conexión abierta y la cierra enseguida, como el de un túnel que se corta.
     * `closed` suma uno cada vez que cerró una.
     */
    private class OneShotServer(status: String, headers: String = "") : Closeable {
        private val server = ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))
        val port: Int get() = server.localPort
        val closed = Semaphore(0)

        init {
            thread(isDaemon = true) {
                while (!server.isClosed) {
                    val socket = runCatching { server.accept() }.getOrNull() ?: break
                    socket.use {
                        val reader = it.getInputStream().bufferedReader()
                        while (true) {
                            val line = reader.readLine() ?: break
                            if (line.isEmpty()) break
                        }
                        val response = "HTTP/1.1 $status\r\nContent-Length: 0\r\nConnection: keep-alive\r\n$headers\r\n"
                        it.getOutputStream().write(response.toByteArray())
                        it.getOutputStream().flush()
                    }
                    closed.release()
                }
            }
        }

        override fun close() = server.close()
    }

    @Test
    fun `un pedido después de que el túnel de atrás se cortó entra igual`() {
        OneShotServer("200 OK").use { server ->
            assertEquals(AppProbe.Check.Ok, AppProbe.check(server.port, "credencial", "prueba"))
            assertTrue("el servidor no cerró la primera conexión", server.closed.tryAcquire(5, TimeUnit.SECONDS))
            assertEquals(AppProbe.Check.Ok, AppProbe.check(server.port, "credencial", "prueba"))
        }
    }

    @Test
    fun `el canje después de un chequeo en el mismo puerto no reusa la conexión muerta`() {
        val cookie = "Set-Cookie: ${AppProbe.DEVICE_COOKIE}=nueva; Path=/; HttpOnly\r\n"
        OneShotServer("303 See Other", "Location: /\r\n$cookie").use { server ->
            AppProbe.check(server.port, "vieja", "prueba")
            assertTrue("el servidor no cerró la primera conexión", server.closed.tryAcquire(5, TimeUnit.SECONDS))
            val redeemed = AppProbe.redeem(server.port, "K7QMX2RD", "prueba")
            assertTrue("dio $redeemed", redeemed is AppProbe.Redeem.Paired)
            assertEquals("nueva", (redeemed as AppProbe.Redeem.Paired).credential)
        }
    }
}
