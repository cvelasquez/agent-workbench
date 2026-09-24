package io.github.cvelasquez.agentworkbench.core

import io.github.cvelasquez.agentworkbench.tunnel.SshSession
import io.github.cvelasquez.agentworkbench.tunnel.SshTarget
import io.github.cvelasquez.agentworkbench.tunnel.TunnelProblem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL

/**
 * El túnel de verdad, contra un servidor SSH que prepara quien corre la prueba
 * (el `sshd` portátil de las mediciones del hito 38 sirve, sin administrador).
 * Sin las variables no corre: en CI no hay servidor.
 *
 *   AW_TEST_SSH=127.0.0.1:2222  AW_TEST_USER=<usuario>  AW_TEST_SEED=<semilla en hex>
 *   AW_TEST_TARGET_PORT=<puerto de un HTTP que conteste>  AW_TEST_LOCAL_PORT=<puerto libre>
 */
class SshSessionIntegrationTest {
    private val env = System.getenv()

    @Test
    fun `abre el túnel con la llave de la semilla, fija la huella y reenvía el puerto`() {
        val ssh = env["AW_TEST_SSH"]
        assumeTrue("sin AW_TEST_SSH no hay servidor contra el que probar", ssh != null)
        val (host, port) = ssh!!.split(':').let { it[0] to it[1].toInt() }
        val seed = hex(env.getValue("AW_TEST_SEED"))
        val targetPort = env.getValue("AW_TEST_TARGET_PORT").toInt()
        val localPort = env.getValue("AW_TEST_LOCAL_PORT").toInt()
        val user = env.getValue("AW_TEST_USER")

        val first = SshSession.open(SshTarget(listOf("10.255.255.1", host), port, user, seed, null, null, targetPort, localPort))
        assertTrue("la primera dirección no contesta y se prueba la siguiente", first is SshSession.Outcome.Up)
        val session = (first as SshSession.Outcome.Up).session
        try {
            assertEquals(host, session.host)
            session.ping()
            val connection = URL("http://127.0.0.1:$localPort/").openConnection() as HttpURLConnection
            assertEquals(200, connection.responseCode)
        } finally {
            session.close()
        }

        // Con la huella fijada entra; con otra, no conecta y dice cuál vio.
        val pinned = SshSession.open(SshTarget(listOf(host), port, user, seed, session.hostKeyAlgorithm, session.hostKey, targetPort, localPort))
        assertTrue(pinned is SshSession.Outcome.Up)
        (pinned as SshSession.Outcome.Up).session.close()
        val wrong = session.hostKey.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
        val changed = SshSession.open(SshTarget(listOf(host), port, user, seed, session.hostKeyAlgorithm, wrong, targetPort, localPort))
        assertTrue(changed is SshSession.Outcome.Down && changed.problem is TunnelProblem.HostKeyChanged)

        // Una llave que el servidor no conoce.
        val stranger = SshSession.open(SshTarget(listOf(host), port, user, ByteArray(32) { 7 }, null, null, targetPort, localPort))
        assertTrue(stranger is SshSession.Outcome.Down && stranger.problem == TunnelProblem.KeyRejected)
    }

    private fun hex(text: String) = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
