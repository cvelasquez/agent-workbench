package io.github.cvelasquez.agentworkbench.core

import java.security.MessageDigest
import java.util.Base64

/**
 * Cómo se presenta el teléfono ante la PC, y cómo se muestra la huella SSH de
 * la PC.
 */
object PhoneIdentity {
    /**
     * El user agent de los pedidos de la app. El servidor lo lee al emparejar
     * (`PHONE_APP_USER_AGENT` en `remote-access.ts`) para nombrar al equipo con el
     * nombre del teléfono, que es lo que el usuario reconoce en la lista.
     */
    fun userAgent(versionName: String, androidRelease: String, deviceName: String): String =
        "AgentWorkbenchAndroid/${clean(versionName, 24).ifEmpty { "0" }} (Android ${clean(androidRelease, 16)}; ${clean(deviceName, 40).ifEmpty { "Android" }})"

    /** Lo que el visor le suma a su user agent: con eso la web ofrece los ajustes de la app. */
    fun webViewUserAgent(base: String, versionName: String): String =
        "$base AgentWorkbenchAndroid/${clean(versionName, 24).ifEmpty { "0" }}"

    /** Sin paréntesis, punto y coma ni saltos: no puede romper el formato que lee el servidor. */
    private fun clean(text: String, max: Int): String =
        text.replace(Regex("[()\\[\\];\\r\\n\\t]"), " ").replace(Regex("\\s+"), " ").trim().take(max).trim()

    /** La huella como la muestra OpenSSH: `SHA256:` y el hash en base64 sin relleno. */
    fun fingerprint(hostKeyBlob: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(hostKeyBlob)
        return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(digest)
    }
}
