package io.github.cvelasquez.agentworkbench.core

import kotlin.math.min

/**
 * Esperas crecientes entre intentos de conectar: rápido al principio, para que
 * un wifi que se cayó un momento se note poco, y hasta cinco minutos, para que
 * fuera de casa la app no gaste batería reintentando sin parar. Un cambio de red
 * o un éxito vuelven a empezar.
 */
class Backoff(private val steps: LongArray = DEFAULT_STEPS) {
    private var attempt = 0

    fun next(): Long = steps[min(attempt, steps.size - 1)].also { attempt++ }

    fun reset() {
        attempt = 0
    }

    companion object {
        val DEFAULT_STEPS = longArrayOf(1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 120_000, 300_000)
    }
}
