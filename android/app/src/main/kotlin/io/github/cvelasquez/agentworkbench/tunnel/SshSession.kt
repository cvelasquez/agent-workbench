package io.github.cvelasquez.agentworkbench.tunnel

import com.google.crypto.tink.subtle.Ed25519Sign
import com.trilead.ssh2.Connection
import com.trilead.ssh2.ConnectionMonitor
import com.trilead.ssh2.LocalPortForwarder
import com.trilead.ssh2.ServerHostKeyVerifier
import com.trilead.ssh2.crypto.keys.Ed25519PrivateKey
import com.trilead.ssh2.crypto.keys.Ed25519PublicKey
import io.github.cvelasquez.agentworkbench.core.PhoneIdentity
import java.io.Closeable
import java.io.IOException
import java.net.BindException
import java.net.ConnectException
import java.net.InetSocketAddress
import java.security.KeyPair

/** Adónde y con qué se conecta el túnel. */
class SshTarget(
    /** En orden: primero la que funcionó la última vez. */
    val hosts: List<String>,
    val port: Int,
    val user: String,
    /** La semilla Ed25519 de la llave del teléfono. */
    val seed: ByteArray,
    /** La huella fijada de la PC, o null en la primera conexión (se fija ahí). */
    val pinnedAlgorithm: String?,
    val pinnedKey: ByteArray?,
    /** El puerto de la app: el mismo en los dos extremos (§14.2). */
    val appPort: Int,
    /** Del lado del teléfono. Siempre el de la app; distinto sólo en la prueba de integración, que corre en la misma PC. */
    val localPort: Int = appPort,
)

/** Por qué no quedó el túnel. Cada una tiene su texto en la pantalla. */
sealed class TunnelProblem {
    /** No hubo respuesta de ninguna dirección: otra red, o la PC apagada. */
    data object PcNotFound : TunnelProblem()

    /** La PC contestó que no hay nada en el puerto SSH: el servidor está apagado. */
    data object SshClosed : TunnelProblem()

    /** La PC no acepta la llave: todavía no se pegó la línea, o se borró. */
    data object KeyRejected : TunnelProblem()

    /** La huella de la PC no es la fijada. No se conecta hasta que el usuario decida. */
    data class HostKeyChanged(val fingerprint: String) : TunnelProblem()

    /** El túnel está, pero Agent Workbench no contesta del otro lado. */
    data object AppNotRunning : TunnelProblem()

    /** Agent Workbench contestó que no reconoce este teléfono (401 o cierre 4001). */
    data object NotAccepted : TunnelProblem()

    /** Otra app del teléfono ocupa el puerto que el túnel necesita. */
    data class LocalPortBusy(val port: Int) : TunnelProblem()

    data object NotPaired : TunnelProblem()

    data class Other(val detail: String) : TunnelProblem()
}

/**
 * Una conexión SSH con la PC y el reenvío del puerto de la app: lo mismo que
 * `ssh -N -L <puerto>:127.0.0.1:<puerto>` (§14), con sshlib (S2).
 *
 * La huella de la PC se fija en la primera conexión y después se exige, con el
 * mismo algoritmo: si la PC ofreciera otro, la comparación daría una falsa
 * alarma. Una huella distinta no conecta: lo decide el usuario.
 */
class SshSession private constructor(
    val host: String,
    val hostKeyAlgorithm: String,
    val hostKey: ByteArray,
    private val connection: Connection,
    private val forwarder: LocalPortForwarder,
) : Closeable {
    /** Por qué se cortó, si se cortó. Lo avisa sshlib desde su hilo. */
    @Volatile
    var lostReason: Throwable? = null
        private set

    /** Un ida y vuelta por el canal: descubre una conexión muerta antes que el sistema. */
    @Throws(IOException::class)
    fun ping() = connection.ping()

    override fun close() {
        runCatching { forwarder.close() }
        runCatching { connection.close() }
    }

    sealed class Outcome {
        class Up(val session: SshSession) : Outcome()
        class Down(val problem: TunnelProblem) : Outcome()
    }

    companion object {
        private const val CONNECT_TIMEOUT_MS = 8_000
        private const val KEX_TIMEOUT_MS = 15_000

        fun open(target: SshTarget): Outcome {
            var refused = 0
            for (host in target.hosts) {
                val connection = Connection(host, target.port)
                target.pinnedAlgorithm?.let { connection.setServerHostKeyAlgorithms(arrayOf(it)) }
                var presented: ByteArray? = null
                val verifier = ServerHostKeyVerifier { _, _, algorithm, key ->
                    val pinned = target.pinnedKey
                    val ok = pinned == null || (algorithm == target.pinnedAlgorithm && key.contentEquals(pinned))
                    if (!ok) presented = key
                    ok
                }
                val info = try {
                    connection.connect(verifier, CONNECT_TIMEOUT_MS, KEX_TIMEOUT_MS)
                } catch (error: IOException) {
                    connection.close()
                    presented?.let { return Outcome.Down(TunnelProblem.HostKeyChanged(PhoneIdentity.fingerprint(it))) }
                    if (isRefused(error)) refused++
                    continue
                }

                val authenticated = try {
                    connection.authenticateWithPublicKey(target.user, keyPair(target.seed))
                } catch (error: IOException) {
                    connection.close()
                    return Outcome.Down(TunnelProblem.Other(error.message ?: error.javaClass.simpleName))
                }
                if (!authenticated) {
                    connection.close()
                    return Outcome.Down(TunnelProblem.KeyRejected)
                }

                val forwarder = try {
                    connection.createLocalPortForwarder(
                        InetSocketAddress("127.0.0.1", target.localPort),
                        "127.0.0.1",
                        target.appPort,
                    )
                } catch (error: IOException) {
                    connection.close()
                    val busy = error is BindException || error.cause is BindException
                    return Outcome.Down(
                        if (busy) TunnelProblem.LocalPortBusy(target.localPort)
                        else TunnelProblem.Other(error.message ?: error.javaClass.simpleName),
                    )
                }

                val session = SshSession(host, info.serverHostKeyAlgorithm, info.serverHostKey, connection, forwarder)
                connection.addConnectionMonitor(ConnectionMonitor { reason ->
                    session.lostReason = reason ?: IOException("connection lost")
                })
                return Outcome.Up(session)
            }
            return Outcome.Down(if (refused == target.hosts.size) TunnelProblem.SshClosed else TunnelProblem.PcNotFound)
        }

        /** El par de llaves de la semilla: la pública la deriva Tink, que ya viene con sshlib. */
        fun keyPair(seed: ByteArray): KeyPair {
            val derived = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
            return KeyPair(Ed25519PublicKey(derived.publicKey), Ed25519PrivateKey(seed))
        }

        private fun isRefused(error: Throwable): Boolean {
            var current: Throwable? = error
            while (current != null) {
                if (current is ConnectException && (current.message ?: "").contains("refused", ignoreCase = true)) return true
                if ((current.message ?: "").contains("ECONNREFUSED")) return true
                current = current.cause
            }
            return false
        }
    }
}
