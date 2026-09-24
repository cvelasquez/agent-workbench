package io.github.cvelasquez.agentworkbench.ui

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.widget.Button
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import io.github.cvelasquez.agentworkbench.BuildConfig
import io.github.cvelasquez.agentworkbench.R
import io.github.cvelasquez.agentworkbench.core.PhoneIdentity
import io.github.cvelasquez.agentworkbench.store.PcStore
import io.github.cvelasquez.agentworkbench.tunnel.AppProbe
import io.github.cvelasquez.agentworkbench.tunnel.Tunnel
import io.github.cvelasquez.agentworkbench.tunnel.TunnelService
import io.github.cvelasquez.agentworkbench.tunnel.TunnelStatus
import kotlin.concurrent.thread

/**
 * Los ajustes, mínimos (hito 38, §15): la PC y su huella, conectar o
 * desconectar, los avisos, la batería y olvidar la PC.
 *
 * La excepción de ahorro de batería **no se pide**: en el hito se midió que el
 * servicio conserva la red en reposo sin ella (S3). Queda como opción, para los
 * teléfonos cuyo fabricante corta los servicios por su cuenta, y abre la
 * pantalla del sistema en vez de pedir el permiso especial.
 */
class SettingsActivity : Activity() {
    private lateinit var store: PcStore
    private lateinit var connectionStatus: TextView
    private lateinit var connectToggle: Button
    private var stopObserving: (() -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Orientation.apply(this)
        setContentView(R.layout.activity_settings)
        edgeToEdge()
        store = PcStore(this)
        val pc = store.load()
        if (pc == null) {
            startActivity(Intent(this, PairingActivity::class.java))
            finish()
            return
        }

        // La dirección de SSH, como la escribiría `ssh`: el puerto sólo si no es el 22. El de
        // la app es un detalle interno del túnel y no se muestra.
        val sshPort = if (pc.sshPort == 22) "" else ":${pc.sshPort}"
        findViewById<TextView>(R.id.computer).text = getString(R.string.settings_computer_address, pc.pcName, pc.user, pc.hosts.first(), sshPort)
        findViewById<TextView>(R.id.fingerprint).text = getString(R.string.settings_fingerprint, PhoneIdentity.fingerprint(pc.hostKey))
        connectionStatus = findViewById(R.id.connectionStatus)
        connectToggle = findViewById(R.id.connectToggle)

        findViewById<Switch>(R.id.notify).apply {
            isChecked = store.notificationsEnabled
            setOnCheckedChangeListener { _, checked -> store.notificationsEnabled = checked }
        }
        findViewById<Button>(R.id.notifySystem).setOnClickListener {
            startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
        }
        findViewById<Button>(R.id.battery).setOnClickListener {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }
        findViewById<Button>(R.id.forget).setOnClickListener { confirmForget() }
        findViewById<TextView>(R.id.about).text = getString(R.string.settings_about, BuildConfig.VERSION_NAME)
        findViewById<Button>(R.id.privacy).setOnClickListener {
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Texts.PRIVACY_URL))) }
        }
    }

    override fun onResume() {
        super.onResume()
        stopObserving = Tunnel.observe(::render)
    }

    override fun onPause() {
        stopObserving?.invoke()
        stopObserving = null
        super.onPause()
    }

    private fun render(status: TunnelStatus) {
        connectionStatus.text = when (status) {
            TunnelStatus.Idle -> getString(R.string.status_disconnected)
            is TunnelStatus.Connecting -> getString(R.string.status_connecting, status.pcName)
            is TunnelStatus.Connected -> getString(R.string.status_connected, status.pcName)
            is TunnelStatus.Waiting -> Texts.problem(this, status.problem)
            is TunnelStatus.Blocked -> Texts.problem(this, status.problem)
        }
        val connected = status !is TunnelStatus.Idle
        connectToggle.text = getString(if (connected) R.string.settings_disconnect else R.string.settings_connect)
        connectToggle.setOnClickListener {
            if (connected) TunnelService.stop(this) else TunnelService.start(this)
        }
    }

    private fun confirmForget() {
        AlertDialog.Builder(this)
            .setMessage(R.string.settings_forget_confirm)
            .setPositiveButton(R.string.settings_forget_ok) { _, _ -> forget() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /**
     * Primero le pide a la PC que lo quite de sus equipos emparejados, si el túnel
     * está arriba: si no, la PC lo seguiría listando y había que revocarlo a mano
     * (24-09-2026). Después borra lo del teléfono. Sin túnel se borra igual, y se
     * avisa que falta revocarlo en la PC.
     */
    private fun forget() {
        val pc = store.load()
        val credential = store.credential()
        val connected = Tunnel.status is TunnelStatus.Connected
        if (pc == null || credential == null || !connected) {
            wipe(toldPc = false)
            return
        }
        findViewById<Button>(R.id.forget).isEnabled = false
        connectionStatus.text = getString(R.string.settings_forget_telling)
        val deviceName = Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME) ?: Build.MODEL
        val userAgent = PhoneIdentity.userAgent(BuildConfig.VERSION_NAME, Build.VERSION.RELEASE, deviceName)
        thread(name = "forget") {
            val told = AppProbe.forgetSelf(pc.appPort, credential, userAgent)
            runOnUiThread { wipe(told) }
        }
    }

    /** Borra la llave, la credencial y la sesión del visor: el teléfono queda como recién instalado. */
    private fun wipe(toldPc: Boolean) {
        if (!toldPc) Toast.makeText(this, R.string.settings_forget_offline, Toast.LENGTH_LONG).show()
        TunnelService.stop(this)
        store.forget()
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        WebStorage.getInstance().deleteAllData()
        startActivity(Intent(this, PairingActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        finish()
    }
}
