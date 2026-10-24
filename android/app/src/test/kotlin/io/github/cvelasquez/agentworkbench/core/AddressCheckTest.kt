package io.github.cvelasquez.agentworkbench.core

import io.github.cvelasquez.agentworkbench.tunnel.AddressCheck
import io.github.cvelasquez.agentworkbench.tunnel.TunnelProblem
import org.junit.Assert.assertEquals
import org.junit.Test

/** Qué gana cuando el usuario escribe varias direcciones en "Cambiar dirección". */
class AddressCheckTest {
    private fun run(vararg answers: Pair<String, AddressCheck>): Pair<Pair<String, AddressCheck>, List<String>> {
        val asked = mutableListOf<String>()
        val byHost = answers.toMap()
        val result = AddressCheck.firstMatch(answers.map { it.first }) { host ->
            asked += host
            byHost.getValue(host)
        }
        return result to asked
    }

    @Test
    fun `la primera que es la PC gana, y no se prueba ninguna más`() {
        val (result, asked) = run(
            "10.0.0.1" to AddressCheck.Unreachable(TunnelProblem.PcNotFound),
            "10.0.0.2" to AddressCheck.SamePc,
            "10.0.0.3" to AddressCheck.SamePc,
        )
        assertEquals("10.0.0.2" to AddressCheck.SamePc, result)
        assertEquals(listOf("10.0.0.1", "10.0.0.2"), asked)
    }

    @Test
    fun `si ninguna es la PC, otro equipo dice más que nada`() {
        val (result, _) = run(
            "10.0.0.1" to AddressCheck.Unreachable(TunnelProblem.PcNotFound),
            "10.0.0.2" to AddressCheck.OtherPc("SHA256:otra"),
        )
        assertEquals("10.0.0.2" to AddressCheck.OtherPc("SHA256:otra"), result)
    }

    @Test
    fun `si nada contesta, lo que pasó con la primera`() {
        val (result, asked) = run(
            "10.0.0.1" to AddressCheck.Unreachable(TunnelProblem.SshClosed),
            "10.0.0.2" to AddressCheck.Unreachable(TunnelProblem.PcNotFound),
        )
        assertEquals("10.0.0.1" to AddressCheck.Unreachable(TunnelProblem.SshClosed), result)
        assertEquals(listOf("10.0.0.1", "10.0.0.2"), asked)
    }
}
