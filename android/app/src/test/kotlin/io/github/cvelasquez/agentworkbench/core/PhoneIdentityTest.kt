package io.github.cvelasquez.agentworkbench.core

import io.github.cvelasquez.agentworkbench.tunnel.AppProbe
import io.github.cvelasquez.agentworkbench.tunnel.SshSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class PhoneIdentityTest {
    /** La misma expresión que `PHONE_APP_USER_AGENT` del servidor (remote-access.ts). */
    private val serverPattern = Regex("AgentWorkbenchAndroid/\\S+ \\(Android [^;)]*; ([^)]{1,80})\\)")

    @Test
    fun `el servidor lee el nombre del teléfono en el user agent`() {
        val agent = PhoneIdentity.userAgent("0.1.0-dev", "15", "Galaxy A16")
        assertEquals("AgentWorkbenchAndroid/0.1.0-dev (Android 15; Galaxy A16)", agent)
        assertEquals("Galaxy A16", serverPattern.find(agent)?.groupValues?.get(1))
    }

    @Test
    fun `un nombre con paréntesis o punto y coma no rompe el formato`() {
        val agent = PhoneIdentity.userAgent("0.1.0", "15", "Mi (nuevo); teléfono\n")
        assertEquals("Mi nuevo teléfono", serverPattern.find(agent)?.groupValues?.get(1))
        assertEquals("Android", serverPattern.find(PhoneIdentity.userAgent("0.1.0", "15", "  "))?.groupValues?.get(1))
    }

    @Test
    fun `el visor suma la marca que la web busca`() {
        assertTrue(PhoneIdentity.webViewUserAgent("Mozilla/5.0 (Linux; Android 15; wv)", "0.1.0").endsWith(" AgentWorkbenchAndroid/0.1.0"))
    }

    @Test
    fun `la huella se muestra como la muestra OpenSSH`() {
        // La llave de las mediciones: el sshd la registró con esta huella.
        val blob = Base64.getDecoder().decode("AAAAC3NzaC1lZDI1NTE5AAAAIOb+qMqIhQvtTqSVWWprEmMSuHzThKLY7MI3NmI4TF0n")
        assertEquals("SHA256:4F5JMavQTJW2Fjk4SYmm1GwSqy+GDo10vLtNsfU7LoY", PhoneIdentity.fingerprint(blob))
    }

    @Test
    fun `el par de llaves de la semilla es el de la RFC 8032`() {
        val seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
        val pair = SshSession.keyPair(seed)
        val publicKey = pair.public as com.trilead.ssh2.crypto.keys.Ed25519PublicKey
        assertEquals("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", publicKey.abyte.joinToString("") { "%02x".format(it) })
    }

    @Test
    fun `la cookie del equipo sale de la respuesta del canje`() {
        assertEquals(
            "abc_DEF-123",
            AppProbe.extractDeviceCookie(
                listOf(
                    "agent_workbench_token=x; Path=/",
                    "agent_workbench_device=abc_DEF-123; Path=/; Max-Age=34560000; SameSite=Strict; HttpOnly",
                ),
            ),
        )
        assertNull(AppProbe.extractDeviceCookie(listOf("agent_workbench_token=x; Path=/")))
        assertNull(AppProbe.extractDeviceCookie(listOf("agent_workbench_device=; Path=/")))
    }

    @Test
    fun `las esperas crecen hasta cinco minutos y vuelven a empezar`() {
        val backoff = Backoff()
        val first = (1..10).map { backoff.next() }
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 30_000L, 60_000L, 120_000L, 300_000L, 300_000L), first)
        backoff.reset()
        assertEquals(1_000L, backoff.next())
    }

    private fun hex(text: String) = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
