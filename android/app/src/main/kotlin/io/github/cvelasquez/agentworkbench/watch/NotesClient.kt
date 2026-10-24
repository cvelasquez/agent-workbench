package io.github.cvelasquez.agentworkbench.watch

import io.github.cvelasquez.agentworkbench.core.ServerMessage
import io.github.cvelasquez.agentworkbench.tunnel.AppProbe
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * La conexión de la pantalla de compartir (hito 50, §15.12) con Agent Workbench,
 * por el túnel: un WebSocket como el del vigía, con la credencial del teléfono.
 * Le pasa a la pantalla la lista de notas cada vez que cambia, y a la subida las
 * respuestas a lo que mandó (`NotesChannel`).
 *
 * Para la PC es una ventana más que pega una imagen en una nota: la nota se
 * actualiza en vivo en las demás.
 */
class NotesClient(
    appPort: Int,
    credential: String,
    userAgent: String,
    private val listener: Listener,
) : NotesChannel {
    interface Listener {
        /** La lista de notas, al conectar y cada vez que cambia. En un hilo de OkHttp. */
        fun onNotes(notes: List<ServerMessage.NoteSummary>)

        /** Se cortó. `notAccepted`: la PC ya no acepta a este teléfono (403 o cierre 4001). */
        fun onClosed(notAccepted: Boolean)
    }

    private val replies = LinkedBlockingQueue<ServerMessage>()

    @Volatile
    private var ended = false
    private val socket: WebSocket

    init {
        val request = Request.Builder()
            .url("ws://127.0.0.1:$appPort/ws")
            .header("Cookie", "${AppProbe.DEVICE_COOKIE}=$credential")
            .header("User-Agent", userAgent)
            .build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                when (val message = ServerMessage.parse(text)) {
                    is ServerMessage.NotesList -> listener.onNotes(message.notes)
                    is ServerMessage.NoteImageStored, is ServerMessage.Failure -> replies.put(message)
                    else -> Unit
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
                end(code == REVOKED_CLOSE_CODE)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = end(code == REVOKED_CLOSE_CODE)

            // Revocado o con el acceso remoto apagado: el pedido de conexión da 403.
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = end(response?.code == 403)
        })
    }

    private fun end(notAccepted: Boolean) {
        if (ended) return
        ended = true
        // Despierta a la subida que esté esperando una respuesta: ya no va a llegar.
        replies.put(ServerMessage.Other)
        listener.onClosed(notAccepted)
    }

    override fun send(text: String): Boolean = !ended && socket.send(text)

    override fun nextReply(timeoutMs: Long): ServerMessage? {
        val reply = replies.poll(timeoutMs, TimeUnit.MILLISECONDS) ?: return null
        return if (reply == ServerMessage.Other) null else reply
    }

    /** La pantalla se fue: sin aviso al oyente. */
    fun close() {
        ended = true
        replies.put(ServerMessage.Other)
        socket.close(1000, null)
    }

    private companion object {
        const val REVOKED_CLOSE_CODE = 4001

        /**
         * Sin conexiones guardadas para reusar, como `AppProbe`: una guardada queda
         * enganchada al túnel que ya murió (§15.9). El ping descubre una conexión
         * muerta mientras la pantalla espera que se elija una nota.
         */
        val client: OkHttpClient = OkHttpClient.Builder()
            .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }
}
