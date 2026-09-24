package io.github.cvelasquez.agentworkbench.core

import org.json.JSONObject

/**
 * Lo que el vigía entiende del WebSocket de la app (`shared/src/protocol.ts`):
 * tres mensajes, y todo lo demás se ignora. Un mensaje que no se entiende no
 * rompe nada: es `Other`.
 */
sealed class ServerMessage {
    data class Hello(val protocolVersion: Int, val remoteClient: Boolean) : ServerMessage()
    data class TerminalList(val terminals: List<Terminal>) : ServerMessage()
    data class Activity(val terminalId: String, val activity: String) : ServerMessage()
    data class Closed(val terminalId: String) : ServerMessage()
    data object Other : ServerMessage()

    /** Una pestaña: lo que hace falta para nombrarla en un aviso. */
    data class Terminal(val terminalId: String, val label: String, val cwd: String) {
        val tabName: String get() = tabName(label, cwd)

        /** El proyecto: la última carpeta de su ruta, aunque la pestaña se llame de otra forma. */
        val projectName: String get() = tabName("", cwd)
    }

    companion object {
        fun parse(text: String): ServerMessage {
            val json = runCatching { JSONObject(text) }.getOrNull() ?: return Other
            return when (json.optString("type")) {
                "hello" -> Hello(json.optInt("protocolVersion", 0), json.optBoolean("remoteClient", false))
                "terminal.list" -> {
                    val array = json.optJSONArray("terminals") ?: return Other
                    val terminals = (0 until array.length()).mapNotNull { index ->
                        val item = array.optJSONObject(index) ?: return@mapNotNull null
                        val id = item.optString("terminalId")
                        if (id.isEmpty()) null else Terminal(id, item.optString("label"), item.optString("cwd"))
                    }
                    TerminalList(terminals)
                }
                "terminal.activity" -> {
                    val id = json.optString("terminalId")
                    val activity = json.optString("activity")
                    if (id.isEmpty() || activity.isEmpty()) Other else Activity(id, activity)
                }
                "terminal.closed" -> {
                    val id = json.optString("terminalId")
                    if (id.isEmpty()) Other else Closed(id)
                }
                else -> Other
            }
        }

        /** El nombre de una pestaña: su etiqueta, o la última carpeta de su ruta (`tabNameFor` de la web). */
        fun tabName(label: String, cwd: String): String {
            if (label.isNotEmpty()) return label
            return cwd.split('\\', '/').lastOrNull { it.isNotEmpty() } ?: cwd
        }

        /**
         * El texto de un aviso, debajo de "«pestaña» terminó": de qué proyecto es y en
         * qué PC. Con el proyecto a la vista se decide sin abrirlo si vale la pena ir.
         */
        fun noticeBody(projectName: String, pcName: String): String =
            if (projectName.isEmpty()) pcName else "$projectName · $pcName"
    }
}
