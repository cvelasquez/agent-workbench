package io.github.cvelasquez.agentworkbench.tunnel

import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.net.URLDecoder
import java.util.concurrent.TimeUnit

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

    private val client = OkHttpClient.Builder()
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
