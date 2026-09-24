package io.github.cvelasquez.agentworkbench.watch

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import io.github.cvelasquez.agentworkbench.core.ActivityTracker
import io.github.cvelasquez.agentworkbench.core.Cancellable
import io.github.cvelasquez.agentworkbench.core.Chime
import io.github.cvelasquez.agentworkbench.core.Scheduler
import io.github.cvelasquez.agentworkbench.core.ServerMessage
import io.github.cvelasquez.agentworkbench.store.PcStore
import io.github.cvelasquez.agentworkbench.tunnel.AppProbe
import io.github.cvelasquez.agentworkbench.tunnel.Tunnel
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import kotlin.math.min

/**
 * El vigía de actividad (hito 38): un WebSocket liviano con la app de la PC,
 * por el túnel, que escucha sólo si cada pestaña trabaja, está libre o espera, y
 * levanta el aviso del teléfono con la misma regla que la web (`ChimeRules`).
 *
 * Vive lo que vive el servicio. Cuando el túnel se cae se **pausa** —cierra el
 * socket y deja de reintentar— y al volver se **reanuda** con el mismo mapa de
 * actividad: lo que cambió mientras tanto avisa una vez.
 *
 * Con la interfaz a la vista no avisa: ahí suena la web.
 */
class ActivityWatcher(
    private val context: Context,
    private val store: PcStore,
    private val userAgent: String,
    /** La app contestó que no reconoce a este teléfono (cierre 4001). */
    private val onNotAccepted: () -> Unit,
) {
    private val thread = HandlerThread("activity-watcher").apply { start() }
    private val handler = Handler(thread.looper)
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .connectTimeout(8, TimeUnit.SECONDS)
        .build()

    private val scheduler = Scheduler { delayMs, task ->
        val runnable = Runnable(task)
        handler.postDelayed(runnable, delayMs)
        Cancellable { handler.removeCallbacks(runnable) }
    }
    private val tracker = ActivityTracker(scheduler) { terminalId, chime -> notify(terminalId, chime) }
    private val tabs = HashMap<String, ServerMessage.Terminal>()

    private var socket: WebSocket? = null
    private var target: Target? = null
    private var generation = 0
    private var failures = 0

    private class Target(val appPort: Int, val credential: String, val pcName: String)

    /** Conecta (o reconecta) con esa app. Se llama con el túnel ya arriba. */
    fun resume(appPort: Int, credential: String, pcName: String) {
        handler.post {
            target = Target(appPort, credential, pcName)
            failures = 0
            connect()
        }
    }

    /** El túnel se cayó: se deja de intentar, pero se conserva el mapa. */
    fun pause() {
        handler.post {
            target = null
            generation++
            socket?.close(1000, null)
            socket = null
        }
    }

    fun shutdown() {
        handler.post {
            target = null
            generation++
            socket?.close(1000, null)
            socket = null
            tracker.clear()
            thread.quitSafely()
        }
    }

    private fun connect() {
        val current = target ?: return
        val mine = ++generation
        socket?.cancel()
        val request = Request.Builder()
            .url("ws://127.0.0.1:${current.appPort}/ws")
            .header("Cookie", "${AppProbe.DEVICE_COOKIE}=${current.credential}")
            .header("User-Agent", userAgent)
            .build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                handler.post { if (mine == generation) failures = 0 }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handler.post { if (mine == generation) handle(ServerMessage.parse(text)) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = ended(mine, code)

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
            }

            // Revocado mientras estaba desconectado: el servidor contesta 403 al pedido de conexión.
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                ended(mine, if (response?.code == 403) REVOKED_CLOSE_CODE else null)
        })
    }

    private fun ended(mine: Int, code: Int?) {
        handler.post {
            if (mine != generation || target == null) return@post
            if (code == REVOKED_CLOSE_CODE) {
                target = null
                onNotAccepted()
                return@post
            }
            failures++
            val delay = min(30_000L, 1_000L shl min(failures, 5))
            handler.postDelayed({ if (mine == generation) connect() }, delay)
        }
    }

    private fun handle(message: ServerMessage) {
        when (message) {
            is ServerMessage.TerminalList -> {
                tabs.clear()
                for (terminal in message.terminals) tabs[terminal.terminalId] = terminal
                tracker.retainOnly(tabs.keys)
            }
            is ServerMessage.Activity -> tracker.onActivity(message.terminalId, message.activity)
            is ServerMessage.Closed -> {
                tabs.remove(message.terminalId)
                tracker.forget(message.terminalId)
            }
            is ServerMessage.Hello, ServerMessage.Other -> Unit
        }
    }

    private fun notify(terminalId: String, chime: Chime) {
        if (Tunnel.uiVisible || !store.notificationsEnabled) return
        val pcName = target?.pcName ?: return
        val tab = tabs[terminalId]
        val body = ServerMessage.noticeBody(tab?.projectName.orEmpty(), pcName)
        AgentNotifier.show(context, terminalId, tab?.tabName ?: terminalId.take(8), chime, body)
    }

    private companion object {
        /** `REMOTE_REVOKED_CLOSE_CODE` del servidor: revocado, o el acceso remoto apagado. */
        const val REVOKED_CLOSE_CODE = 4001
    }
}
