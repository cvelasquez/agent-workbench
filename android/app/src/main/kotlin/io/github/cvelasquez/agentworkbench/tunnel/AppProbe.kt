package io.github.cvelasquez.agentworkbench.tunnel

import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.net.URLDecoder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Los pedidos HTTP a Agent Workbench **por el túnel**: al `127.0.0.1` del
 * teléfono, que sshlib reenvía al `127.0.0.1` de la PC. Para el servidor es una
 * petición de loopback como cualquier otra (§14.4).
 *
 * Sin `Origin`: el servidor lo acepta ausente —un cliente que no es un
 * navegador no lo manda— y la credencial va en su cookie, que es por donde el
 * servidor la acepta. No hizo falta tocar el servidor para el vigía.
 */
object AppProbe {
    /** La cookie de un equipo emparejado (`DEVICE_COOKIE` en `security.ts`). */
    const val DEVICE_COOKIE = "agent_workbench_device"

    /**
     * Sin conexiones guardadas para reusar (`ConnectionPool(0, …)`): cada pedido
     * abre la suya. Una guardada queda enganchada al reenviador de un túnel que
     * ya murió —el de antes de "Olvidar", o el del emparejamiento— y el pedido
     * siguiente fallaba con "no contesta" aunque la PC estuviera ahí; el segundo
     * intento entraba (24-09-2026, `AppProbeTest`). Son pedidos al `127.0.0.1`
     * del teléfono: abrir una conexión no cuesta nada.
     */
    private val client = OkHttpClient.Builder()
        .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    sealed class Redeem {
        class Paired(val credential: String) : Redeem()
        data object CodeRejected : Redeem()
        data object NotReachable : Redeem()
        class Unexpected(val status: Int) : Redeem()
    }

    /**
     * Canjea el código de un solo uso por la credencial del equipo (§14.3): el
     * servidor contesta 303 con la cookie, o 401 si el código no vale.
     */
    fun redeem(appPort: Int, code: String, userAgent: String): Redeem {
        val request = Request.Builder()
            .url("http://127.0.0.1:$appPort/?pair=$code")
            .header("User-Agent", userAgent)
            .build()
        return try {
            client.newCall(request).execute().use { response ->
                when (response.code) {
                    in 300..399 -> extractDeviceCookie(response.headers("Set-Cookie"))?.let { Redeem.Paired(it) }
                        ?: Redeem.Unexpected(response.code)
                    401 -> Redeem.CodeRejected
                    else -> Redeem.Unexpected(response.code)
                }
            }
        } catch (_: IOException) {
            Redeem.NotReachable
        }
    }

    sealed class Check {
        data object Ok : Check()
        data object NotAccepted : Check()
        data object NotReachable : Check()
        class Unexpected(val status: Int) : Check()
    }

    /**
     * ¿Contesta Agent Workbench, y acepta a este teléfono? Si la PC no tiene
     * nada escuchando en el puerto, el canal del túnel se cierra y OkHttp lo ve
     * como una conexión cortada: `NotReachable`.
     */
    fun check(appPort: Int, credential: String, userAgent: String): Check {
        val request = Request.Builder()
            .url("http://127.0.0.1:$appPort/")
            .header("Cookie", "$DEVICE_COOKIE=$credential")
            .header("User-Agent", userAgent)
            .build()
        return try {
            client.newCall(request).execute().use { response ->
                when (response.code) {
                    200 -> Check.Ok
                    401 -> Check.NotAccepted
                    else -> Check.Unexpected(response.code)
                }
            }
        } catch (_: IOException) {
            Check.NotReachable
        }
    }

    /**
     * "Olvidar este equipo": le pide a la app que revoque a este teléfono
     * (`remote.device.forgetSelf`), con el túnel ya arriba. El acuse es el
     * cierre 4001 con que el servidor echa a un equipo revocado. Bloquea hasta
     * `timeoutMs`: se llama fuera del hilo principal. True si la PC lo revocó.
     */
    fun forgetSelf(appPort: Int, credential: String, userAgent: String, timeoutMs: Long = 5_000): Boolean {
        val done = CountDownLatch(1)
        val revoked = AtomicBoolean(false)
        val request = Request.Builder()
            .url("ws://127.0.0.1:$appPort/ws")
            .header("Cookie", "$DEVICE_COOKIE=$credential")
            .header("User-Agent", userAgent)
            .build()
        val socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send("""{"type":"remote.device.forgetSelf"}""")
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                revoked.set(code == REVOKED_CLOSE_CODE)
                webSocket.close(code, null)
                done.countDown()
            }

            // Ya revocado (o el acceso apagado): el pedido de conexión da 403. También cuenta.
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                revoked.set(response?.code == 403)
                done.countDown()
            }
        })
        val answered = done.await(timeoutMs, TimeUnit.MILLISECONDS)
        if (!answered) socket.cancel()
        return revoked.get()
    }

    /** `REMOTE_REVOKED_CLOSE_CODE` del servidor. */
    private const val REVOKED_CLOSE_CODE = 4001

    /** El valor de la cookie del equipo entre las `Set-Cookie` de una respuesta, o null. */
    fun extractDeviceCookie(setCookieHeaders: List<String>): String? {
        for (header in setCookieHeaders) {
            val first = header.substringBefore(';').trim()
            if (!first.startsWith("$DEVICE_COOKIE=")) continue
            val raw = first.substringAfter('=')
            val value = runCatching { URLDecoder.decode(raw, "UTF-8") }.getOrNull() ?: continue
            if (value.isNotEmpty()) return value
        }
        return null
    }
}
