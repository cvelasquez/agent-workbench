package io.github.cvelasquez.agentworkbench.core

import org.json.JSONObject

/**
 * Lo que la app entiende del WebSocket de Agent Workbench (`shared/src/protocol.ts`):
 * el vigía lee el saludo, las pestañas y su actividad; compartir a una nota (hito
 * 50), la lista de notas, el acuse de una imagen y los errores. Todo lo demás se
 * ignora: un mensaje que no se entiende no rompe nada, es `Other`.
 */
sealed class ServerMessage {
    data class Hello(val protocolVersion: Int, val remoteClient: Boolean) : ServerMessage()
    data class TerminalList(val terminals: List<Terminal>) : ServerMessage()
    data class Activity(val terminalId: String, val activity: String) : ServerMessage()
    data class Closed(val terminalId: String) : ServerMessage()
    data class NotesList(val notes: List<NoteSummary>) : ServerMessage()

    /** `notes.imageData`: la PC guardó la imagen que le mandó esta conexión. */
    data class NoteImageStored(val imageId: String) : ServerMessage()

    /** `error`: el texto viaja como clave y valores (§6.23), y la app arma la frase. */
    data class Failure(val code: String, val key: String, val params: Map<String, String>) : ServerMessage()
    data object Other : ServerMessage()

    /** Una nota, con lo que hace falta para elegirla: el texto da el título. */
    data class NoteSummary(val noteId: String, val text: String, val images: Int, val updatedAt: Long)

    /** Una pestaña: lo que hace falta para nombrarla en un aviso. */
    data class Terminal(val terminalId: String, val label: String, val cwd: String) {
        val tabName: String get() = tabName(label, cwd)

        /** El proyecto: la última carpeta de su ruta, aunque la pestaña se llame de otra forma. */
        val projectName: String get() = tabName("", cwd)
    }

    companion object {
        /**
         * `notes.imageData` trae la imagen entera de vuelta, megas en base64: se
         * reconoce por el principio, sin leer el resto. La PC lo arma siempre con
         * `type` y `imageId` primero (`terminal-socket.ts`).
         */
        private val IMAGE_STORED = Regex("^\\{\"type\":\"notes\\.imageData\",\"imageId\":\"([^\"]+)\"")

        fun parse(text: String): ServerMessage {
            IMAGE_STORED.find(text.take(160))?.let { return NoteImageStored(it.groupValues[1]) }
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
                "notes.list" -> {
                    val array = json.optJSONArray("notes") ?: return Other
                    val notes = (0 until array.length()).mapNotNull { index ->
                        val item = array.optJSONObject(index) ?: return@mapNotNull null
                        val id = item.optString("noteId")
                        if (id.isEmpty()) null
                        else NoteSummary(id, item.optString("text"), item.optJSONArray("images")?.length() ?: 0, item.optLong("updatedAt"))
                    }
                    NotesList(notes)
                }
                // Por si un día cambia el orden de los campos: más lento, pero no se pierde el acuse.
                "notes.imageData" -> json.optString("imageId").let { if (it.isEmpty()) Other else NoteImageStored(it) }
                "error" -> {
                    val textJson = json.optJSONObject("text")
                    val params = textJson?.optJSONObject("params")
                    Failure(
                        json.optString("code"),
                        textJson?.optString("key").orEmpty(),
                        params?.keys()?.asSequence()?.associateWith { params.optString(it) }.orEmpty(),
                    )
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
