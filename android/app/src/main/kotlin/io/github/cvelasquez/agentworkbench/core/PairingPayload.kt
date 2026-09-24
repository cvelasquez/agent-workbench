package io.github.cvelasquez.agentworkbench.core

import java.net.URLDecoder
import java.util.Base64

/**
 * Lo que trae el código QR del diálogo "Acceso remoto" de la PC (hito 38, §15).
 *
 * El servidor lo arma en `phone-pairing.ts`:
 *
 *   agentworkbench://pair?v=1&n=<equipo>&h=<ip>,<ip>&p=22&u=<usuario>&a=<puerto>&c=<código>&k=<semilla>
 *
 * `k` es la semilla Ed25519 de la llave SSH del teléfono, 32 bytes en base64url:
 * de ahí sale el par de llaves. Una versión que no se entiende no se lee, y cada
 * campo se valida por su forma: el texto llega de una cámara, y lo que no tiene
 * la forma de lo que manda Agent Workbench no se usa.
 */
class PairingPayload(
    val pcName: String,
    val hosts: List<String>,
    val sshPort: Int,
    val user: String,
    val appPort: Int,
    /** El código de un solo uso, sin guion. */
    val code: String,
    val seed: ByteArray,
) {
    /** Sin la semilla: esto puede terminar en un registro. */
    override fun toString(): String = "PairingPayload(pc=$pcName, hosts=$hosts, ssh=$sshPort, user=$user, app=$appPort)"

    companion object {
        const val PREFIX = "agentworkbench://pair?"
        const val VERSION = "1"

        /** Una IPv4 o un nombre de equipo: sin espacios ni nada que no vaya en una dirección. */
        private val HOST = Regex("^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")

        /** El alfabeto del código (`PAIRING_ALPHABET` del servidor): sin 0, 1, I ni O. */
        private val CODE = Regex("^[A-HJ-NP-Z2-9]{8}$")

        fun parse(text: String): PairingPayload? {
            val trimmed = text.trim()
            if (!trimmed.startsWith(PREFIX)) return null
            val params = HashMap<String, String>()
            for (part in trimmed.substring(PREFIX.length).split('&')) {
                val equals = part.indexOf('=')
                if (equals <= 0) continue
                val key = decode(part.substring(0, equals)) ?: return null
                val value = decode(part.substring(equals + 1)) ?: return null
                params[key] = value
            }
            if (params["v"] != VERSION) return null
            val pcName = params["n"]?.trim()?.takeIf { it.isNotEmpty() }?.take(80) ?: return null
            val hosts = params["h"].orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() }
            if (hosts.isEmpty() || hosts.size > 8 || !hosts.all { HOST.matches(it) }) return null
            val sshPort = params["p"]?.toIntOrNull()?.takeIf { it in 1..65535 } ?: return null
            val user = params["u"]?.takeIf { it.isNotEmpty() && it.length <= 256 && '\n' !in it } ?: return null
            val appPort = params["a"]?.toIntOrNull()?.takeIf { it in 1024..65535 } ?: return null
            val code = params["c"]?.uppercase()?.takeIf { CODE.matches(it) } ?: return null
            val seed = params["k"]
                ?.let { runCatching { Base64.getUrlDecoder().decode(it) }.getOrNull() }
                ?.takeIf { it.size == 32 } ?: return null
            return PairingPayload(pcName, hosts, sshPort, user, appPort, code, seed)
        }

        private fun decode(value: String): String? = runCatching { URLDecoder.decode(value, "UTF-8") }.getOrNull()
    }
}
