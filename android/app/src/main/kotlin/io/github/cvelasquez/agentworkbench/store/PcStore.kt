package io.github.cvelasquez.agentworkbench.store

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import io.github.cvelasquez.agentworkbench.core.PairingPayload
import java.util.Base64

/** La PC con la que está emparejado el teléfono. Nada secreto: eso lo guarda `SecretBox`. */
class PairedPc(
    val pcName: String,
    /** Por dónde probar, con la que funcionó la última vez primero. */
    val hosts: List<String>,
    val sshPort: Int,
    val user: String,
    val appPort: Int,
    val hostKeyAlgorithm: String,
    val hostKey: ByteArray,
    val pairedAt: Long,
)

/**
 * Lo que guarda el teléfono de su PC, y nada más: ni historial, ni archivos, ni
 * conversaciones. Una PC por teléfono, que es el caso del hito.
 */
class PcStore(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("pc", Context.MODE_PRIVATE)
    private val secrets: SharedPreferences = context.getSharedPreferences("secrets", Context.MODE_PRIVATE)
    private val settings: SharedPreferences = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    fun load(): PairedPc? {
        val pcName = prefs.getString(KEY_NAME, null) ?: return null
        val hosts = prefs.getString(KEY_HOSTS, null)?.split(',')?.filter { it.isNotEmpty() }.orEmpty()
        val algorithm = prefs.getString(KEY_HOST_KEY_ALGORITHM, null) ?: return null
        val hostKey = prefs.getString(KEY_HOST_KEY, null)?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() } ?: return null
        val user = prefs.getString(KEY_USER, null) ?: return null
        if (hosts.isEmpty()) return null
        val last = prefs.getString(KEY_LAST_HOST, null)
        val ordered = if (last != null && last in hosts) listOf(last) + hosts.filter { it != last } else hosts
        return PairedPc(
            pcName = pcName,
            hosts = ordered,
            sshPort = prefs.getInt(KEY_SSH_PORT, 22),
            user = user,
            appPort = prefs.getInt(KEY_APP_PORT, 0),
            hostKeyAlgorithm = algorithm,
            hostKey = hostKey,
            pairedAt = prefs.getLong(KEY_PAIRED_AT, 0),
        )
    }

    fun seed(): ByteArray? = secrets.getString(KEY_SEED, null)?.let { SecretBox.open(it) }?.takeIf { it.size == 32 }

    fun credential(): String? = secrets.getString(KEY_CREDENTIAL, null)?.let { SecretBox.open(it) }?.toString(Charsets.UTF_8)

    /**
     * Queda emparejado: la PC, su huella fijada, y lo secreto cifrado. Con `commit`
     * y no `apply`: el servicio que arranca después lee esto de disco.
     */
    @SuppressLint("ApplySharedPref")
    fun savePairing(payload: PairingPayload, host: String, hostKeyAlgorithm: String, hostKey: ByteArray, credential: String) {
        secrets.edit()
            .putString(KEY_SEED, SecretBox.seal(payload.seed))
            .putString(KEY_CREDENTIAL, SecretBox.seal(credential.toByteArray(Charsets.UTF_8)))
            .commit()
        prefs.edit()
            .putString(KEY_NAME, payload.pcName)
            .putString(KEY_HOSTS, payload.hosts.joinToString(","))
            .putString(KEY_LAST_HOST, host)
            .putInt(KEY_SSH_PORT, payload.sshPort)
            .putString(KEY_USER, payload.user)
            .putInt(KEY_APP_PORT, payload.appPort)
            .putString(KEY_HOST_KEY_ALGORITHM, hostKeyAlgorithm)
            .putString(KEY_HOST_KEY, Base64.getEncoder().encodeToString(hostKey))
            .putLong(KEY_PAIRED_AT, System.currentTimeMillis())
            .commit()
    }

    fun rememberHost(host: String) {
        prefs.edit().putString(KEY_LAST_HOST, host).apply()
    }

    /**
     * Olvida la PC: borra lo guardado, también los dos ajustes, y la llave con la que
     * se cifró lo secreto. PRIVACY.md promete que "Olvidar" no deja nada.
     */
    @SuppressLint("ApplySharedPref")
    fun forget() {
        prefs.edit().clear().commit()
        secrets.edit().clear().commit()
        settings.edit().clear().commit()
        SecretBox.destroy()
    }

    var notificationsEnabled: Boolean
        get() = settings.getBoolean(KEY_NOTIFY, true)
        set(value) {
            settings.edit().putBoolean(KEY_NOTIFY, value).apply()
        }

    /** El usuario pidió desconectar: la app no vuelve a conectar sola hasta que lo pida. */
    var connectionWanted: Boolean
        get() = settings.getBoolean(KEY_CONNECTION_WANTED, true)
        set(value) {
            settings.edit().putBoolean(KEY_CONNECTION_WANTED, value).apply()
        }

    private companion object {
        const val KEY_NAME = "name"
        const val KEY_HOSTS = "hosts"
        const val KEY_LAST_HOST = "lastHost"
        const val KEY_SSH_PORT = "sshPort"
        const val KEY_USER = "user"
        const val KEY_APP_PORT = "appPort"
        const val KEY_HOST_KEY_ALGORITHM = "hostKeyAlgorithm"
        const val KEY_HOST_KEY = "hostKey"
        const val KEY_PAIRED_AT = "pairedAt"
        const val KEY_SEED = "seed"
        const val KEY_CREDENTIAL = "credential"
        const val KEY_NOTIFY = "notify"
        const val KEY_CONNECTION_WANTED = "connectionWanted"
    }
}
