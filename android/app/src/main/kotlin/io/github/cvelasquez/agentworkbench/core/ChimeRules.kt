package io.github.cvelasquez.agentworkbench.core

/** `DONE`: el agente terminó. `ATTENTION`: se frenó a esperar un permiso o una respuesta. */
enum class Chime { DONE, ATTENTION }

/**
 * Cuándo avisa el teléfono: **la misma regla que el sonido y la notificación de
 * la web** (`notification-sound.ts`, §6.20), para que el teléfono no avise
 * distinto que la PC.
 *
 *  - `busy → idle`, sostenido 1,5 s, es "terminó": el estado puede pasar por
 *    `idle` entre dos herramientas, y avisar en cada hueco sería repicar toda la
 *    corrida.
 *  - Cualquier cosa `→ waiting` es "te espera", en el acto.
 *  - Sin estado anterior no avisa: es la tanda que llega al conectar.
 *  - `unknown` y `offline` no avisan nunca.
 */
object ChimeRules {
    const val DONE_HOLD_MS = 1_500L

    fun chimeFor(previous: String?, next: String): Chime? {
        if (previous == null || previous == next) return null
        if (next == "waiting") return Chime.ATTENTION
        if (next == "idle" && previous == "busy") return Chime.DONE
        return null
    }
}

/** Un plazo que se puede cancelar. */
fun interface Cancellable {
    fun cancel()
}

/** Quién pone los plazos: un `Handler` en la app, un reloj de mentira en las pruebas. */
fun interface Scheduler {
    fun schedule(delayMs: Long, task: () -> Unit): Cancellable
}

/**
 * El mapa de actividad de las pestañas y los avisos que salen de sus cambios.
 *
 * Vive lo que vive el vigía, **también a través de las reconexiones**: una
 * pestaña que cambió de estado mientras el túnel estaba caído avisa una vez al
 * volver, como en la web.
 */
class ActivityTracker(
    private val scheduler: Scheduler,
    private val onChime: (terminalId: String, chime: Chime) -> Unit,
) {
    private val activity = HashMap<String, String>()
    private val pending = HashMap<String, Cancellable>()

    fun activityOf(terminalId: String): String? = activity[terminalId]

    fun onActivity(terminalId: String, next: String) {
        val previous = activity.put(terminalId, next)
        if (previous == next) return
        pending.remove(terminalId)?.cancel()
        when (ChimeRules.chimeFor(previous, next)) {
            Chime.ATTENTION -> onChime(terminalId, Chime.ATTENTION)
            Chime.DONE -> pending[terminalId] = scheduler.schedule(ChimeRules.DONE_HOLD_MS) {
                pending.remove(terminalId)
                if (activity[terminalId] == "idle") onChime(terminalId, Chime.DONE)
            }
            null -> Unit
        }
    }

    /** Las pestañas que ya no están se olvidan, con su plazo. */
    fun retainOnly(terminalIds: Set<String>) {
        for (terminalId in activity.keys.filter { it !in terminalIds }) forget(terminalId)
    }

    fun forget(terminalId: String) {
        activity.remove(terminalId)
        pending.remove(terminalId)?.cancel()
    }

    fun clear() {
        pending.values.forEach { it.cancel() }
        pending.clear()
        activity.clear()
    }
}
