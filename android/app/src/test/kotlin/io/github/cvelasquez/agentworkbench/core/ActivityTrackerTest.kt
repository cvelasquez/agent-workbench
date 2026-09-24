package io.github.cvelasquez.agentworkbench.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** La regla de los avisos: la misma que el sonido de la web (check-notification-sound.mjs). */
class ActivityTrackerTest {
    /** Un reloj de mentira: los plazos corren cuando se lo adelanta. */
    private class FakeClock : Scheduler {
        var now = 0L
        private val tasks = mutableListOf<Triple<Long, () -> Unit, BooleanArray>>()

        override fun schedule(delayMs: Long, task: () -> Unit): Cancellable {
            val cancelled = BooleanArray(1)
            tasks.add(Triple(now + delayMs, task, cancelled))
            return Cancellable { cancelled[0] = true }
        }

        fun advance(ms: Long) {
            now += ms
            val due = tasks.filter { it.first <= now }
            tasks.removeAll(due)
            due.forEach { if (!it.third[0]) it.second() }
        }
    }

    private val clock = FakeClock()
    private val chimes = mutableListOf<Pair<String, Chime>>()
    private val tracker = ActivityTracker(clock) { id, chime -> chimes.add(id to chime) }

    @Test
    fun `las transiciones que avisan y las que no`() {
        assertEquals(Chime.ATTENTION, ChimeRules.chimeFor("busy", "waiting"))
        assertEquals(Chime.ATTENTION, ChimeRules.chimeFor("idle", "waiting"))
        assertEquals(Chime.DONE, ChimeRules.chimeFor("busy", "idle"))
        assertNull(ChimeRules.chimeFor(null, "waiting"))
        assertNull(ChimeRules.chimeFor("idle", "busy"))
        assertNull(ChimeRules.chimeFor("waiting", "idle"))
        assertNull(ChimeRules.chimeFor("busy", "unknown"))
        assertNull(ChimeRules.chimeFor("busy", "offline"))
        assertNull(ChimeRules.chimeFor("idle", "idle"))
    }

    @Test
    fun `la tanda de conectar no avisa`() {
        tracker.onActivity("a", "waiting")
        tracker.onActivity("b", "idle")
        clock.advance(5_000)
        assertEquals(emptyList<Pair<String, Chime>>(), chimes)
    }

    @Test
    fun `te espera avisa en el acto`() {
        tracker.onActivity("a", "busy")
        tracker.onActivity("a", "waiting")
        assertEquals(listOf("a" to Chime.ATTENTION), chimes)
    }

    @Test
    fun `terminó avisa si el reposo se sostiene un segundo y medio`() {
        tracker.onActivity("a", "busy")
        tracker.onActivity("a", "idle")
        clock.advance(1_499)
        assertEquals(emptyList<Pair<String, Chime>>(), chimes)
        clock.advance(1)
        assertEquals(listOf("a" to Chime.DONE), chimes)
    }

    @Test
    fun `un hueco entre dos herramientas no avisa`() {
        tracker.onActivity("a", "busy")
        tracker.onActivity("a", "idle")
        clock.advance(800)
        tracker.onActivity("a", "busy")
        clock.advance(5_000)
        assertEquals(emptyList<Pair<String, Chime>>(), chimes)
    }

    @Test
    fun `de terminado a esperando suena solo te espera`() {
        tracker.onActivity("a", "busy")
        tracker.onActivity("a", "idle")
        tracker.onActivity("a", "waiting")
        clock.advance(5_000)
        assertEquals(listOf("a" to Chime.ATTENTION), chimes)
    }

    @Test
    fun `una pestaña cerrada o que ya no está en la lista cancela su plazo`() {
        tracker.onActivity("a", "busy")
        tracker.onActivity("b", "busy")
        tracker.onActivity("a", "idle")
        tracker.onActivity("b", "idle")
        tracker.forget("a")
        tracker.retainOnly(setOf("c"))
        clock.advance(5_000)
        assertEquals(emptyList<Pair<String, Chime>>(), chimes)
    }

    @Test
    fun `el mapa sobrevive a la reconexión, y lo que cambió mientras tanto avisa una vez`() {
        tracker.onActivity("a", "busy")
        // Se cae el túnel y vuelve: el servidor manda otra vez el estado de cada pestaña.
        tracker.onActivity("a", "waiting")
        tracker.onActivity("a", "waiting")
        assertEquals(listOf("a" to Chime.ATTENTION), chimes)
    }
}
