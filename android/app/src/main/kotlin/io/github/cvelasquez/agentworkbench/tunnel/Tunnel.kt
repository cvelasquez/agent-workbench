package io.github.cvelasquez.agentworkbench.tunnel

import android.os.Handler
import android.os.Looper
import java.util.concurrent.CopyOnWriteArrayList

/** En qué está la conexión con la PC. */
sealed class TunnelStatus {
    data object Idle : TunnelStatus()
    data class Connecting(val pcName: String) : TunnelStatus()
    data class Connected(val pcName: String, val host: String) : TunnelStatus()

    /** Falló y se vuelve a intentar sola en `retryAt` (reloj de pared). */
    data class Waiting(val problem: TunnelProblem, val retryAt: Long) : TunnelStatus()

    /** Falló y no se reintenta: hace falta el usuario (huella distinta, teléfono no aceptado). */
    data class Blocked(val problem: TunnelProblem) : TunnelStatus()
}

/**
 * El estado de la conexión, compartido entre el servicio que la mantiene y las
 * pantallas que la muestran. Los oyentes reciben cada cambio en el hilo
 * principal.
 */
object Tunnel {
    @Volatile
    var status: TunnelStatus = TunnelStatus.Idle
        private set

    /** La interfaz está a la vista: ahí suena la web y el teléfono no levanta avisos. */
    @Volatile
    var uiVisible: Boolean = false

    private val listeners = CopyOnWriteArrayList<(TunnelStatus) -> Unit>()
    private val main = Handler(Looper.getMainLooper())

    fun publish(next: TunnelStatus) {
        status = next
        main.post { listeners.forEach { it(next) } }
    }

    /** Engancha un oyente y le pasa el estado actual. Devuelve cómo soltarlo. */
    fun observe(listener: (TunnelStatus) -> Unit): () -> Unit {
        listeners.add(listener)
        main.post { listener(status) }
        return { listeners.remove(listener) }
    }
}
