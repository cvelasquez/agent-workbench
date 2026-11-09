package io.github.cvelasquez.agentworkbench.core

import java.io.IOException
import java.io.InputStream
import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URLDecoder

/** Solo descarga adjuntos desde el puerto local que ya está emparejado. */
object NoteDownloads {
    data class Target(val fileId: String, val name: String)

    fun targetOf(url: String, appPort: Int): Target? {
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        if (uri.scheme != "http" || uri.host !in setOf("127.0.0.1", "localhost") || uri.port != appPort || uri.userInfo != null) return null
        val id = Regex("^/api/notes/files/([A-Za-z0-9-]{1,64})$").matchEntire(uri.rawPath.orEmpty())?.groupValues?.get(1) ?: return null
        val rawName = uri.rawQuery?.split('&')?.firstOrNull { it.startsWith("name=") }?.substringAfter('=')
        val name = runCatching { URLDecoder.decode(rawName.orEmpty(), "UTF-8") }.getOrDefault("")
            .substringAfterLast('/').substringAfterLast('\\').filter { !it.isISOControl() }.trim().take(255).ifBlank { "attachment" }
        return Target(id, name)
    }

    /** Se comprueba también el flujo real; un Content-Length declarado no es suficiente. */
    fun read(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        val limit = SharedItems.MAX_FILE_BYTES + 1
        while (out.size() < limit) {
            val count = input.read(buffer, 0, minOf(buffer.size, limit - out.size()))
            if (count < 0) break
            out.write(buffer, 0, count)
        }
        val bytes = out.toByteArray()
        if (bytes.size > SharedItems.MAX_FILE_BYTES) throw IOException("attachment too large")
        return bytes
    }
}
