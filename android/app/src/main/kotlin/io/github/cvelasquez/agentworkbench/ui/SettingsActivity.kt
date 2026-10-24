package io.github.cvelasquez.agentworkbench.ui

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.widget.Button
import android.widget.EditText
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import io.github.cvelasquez.agentworkbench.BuildConfig
import io.github.cvelasquez.agentworkbench.R
import io.github.cvelasquez.agentworkbench.core.PairingPayload
import io.github.cvelasquez.agentworkbench.core.PhoneIdentity
import io.github.cvelasquez.agentworkbench.store.PairedPc
import io.github.cvelasquez.agentworkbench.store.PcStore
import io.github.cvelasquez.agentworkbench.tunnel.AddressCheck
import io.github.cvelasquez.agentworkbench.tunnel.AppProbe
import io.github.cvelasquez.agentworkbench.tunnel.SshSession
import io.github.cvelasquez.agentworkbench.tunnel.Tunnel
import io.github.cvelasquez.agentworkbench.tunnel.TunnelService
import io.github.cvelasquez.agentworkbench.tunnel.TunnelStatus
import kotlin.concurrent.thread

/**
 * Los ajustes, mínimos (hito 38, §15): la PC y su huella, cambiar su dirección
 * (hito 50), conectar o desconectar, los avisos, la batería y olvidar la PC.
 *
 * La excepción de ahorro de batería **no se pide**: en el hito se midió que el
 * servicio conserva la red en reposo sin ella (S3). Queda como opción, para los
 * teléfonos cuyo fabricante corta los servicios por su cuenta, y abre la
 * pantalla del sistema en vez de pedir el permiso especial.
 */
class SettingsActivity : Activity() {
    companion object {
        /** Abre "Cambiar dirección" al entrar: lo pide la capa del visor cuando no encuentra la PC. */
        const val EXTRA_EDIT_ADDRESS = "editAddress"
    }

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

        renderComputer(pc)
        findViewById<TextView>(R.id.fingerprint).text = getString(R.string.settings_fingerprint, PhoneIdentity.fingerprint(pc.hostKey))
        findViewById<Button>(R.id.changeAddress).setOnClickListener { editAddress() }
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
        if (savedInstanceState == null && intent.getBooleanExtra(EXTRA_EDIT_ADDRESS, false)) editAddress()
    }

    /**
     * La dirección de SSH, como la escribiría `ssh`: el puerto sólo si no es el 22. El de
     * la app es un detalle interno del túnel y no se muestra.
     */
    private fun renderComputer(pc: PairedPc) {
        val sshPort = if (pc.sshPort == 22) "" else ":${pc.sshPort}"
        findViewById<TextView>(R.id.computer).text = getString(R.string.settings_computer_address, pc.pcName, pc.user, pc.hosts.first(), sshPort)
    }

    /**
     * "Cambiar dirección" (§15.4): cuando el router le dio otra IP a la PC, se escribe la
     * nueva en vez de revocar y emparejar otra vez. La llave y la credencial no dependen
     * de la IP. Se guarda sólo si en esa dirección contesta la PC emparejada, con su
     * huella: si no, el cuadro dice qué contestó y queda abierto.
     */
    private fun editAddress() {
        val pc = store.load() ?: return
        val view = layoutInflater.inflate(R.layout.dialog_address, null)
        val input = view.findViewById<EditText>(R.id.addressInput)
        val status = view.findViewById<TextView>(R.id.addressStatus)
        input.setText(pc.hosts.joinToString(", "))
        input.setSelection(input.text.length)
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.address_title)
            .setView(view)
            .setPositiveButton(R.string.address_check, null)
            .setNegativeButton(R.string.cancel, null)
            .create()
        dialog.setOnShowListener {
            val check = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            check.setOnClickListener { checkAddress(dialog, input, status, check) }
            input.setOnEditorActionListener { _, actionId, event ->
                // Un Enter de un teclado físico llega como IME_NULL, al bajar y al subir.
                val enter = actionId == EditorInfo.IME_NULL && event?.keyCode == KeyEvent.KEYCODE_ENTER
                if (actionId != EditorInfo.IME_ACTION_GO && !enter) return@setOnEditorActionListener false
                if ((event == null || event.action == KeyEvent.ACTION_DOWN) && check.isEnabled) checkAddress(dialog, input, status, check)
                true
            }
        }
        dialog.show()
    }

    private fun checkAddress(dialog: AlertDialog, input: EditText, status: TextView, check: Button) {
        val pc = store.load() ?: return dialog.dismiss()
        val hosts = PairingPayload.parseHosts(input.text.toString())
        if (hosts == null) {
            status.text = getString(R.string.address_invalid)
            return
        }
        check.isEnabled = false
        input.isEnabled = false
        status.text = getString(R.string.address_checking, hosts.joinToString(", "))
        thread(name = "address-check") {
            val (host, result) = AddressCheck.firstMatch(hosts) { SshSession.check(it, pc.sshPort, pc.hostKeyAlgorithm, pc.hostKey) }
            runOnUiThread {
                // Cancelado mientras probaba: no se guarda nada.
                if (isFinishing || isDestroyed || !dialog.isShowing) return@runOnUiThread
                when (result) {
                    AddressCheck.SamePc -> {
                        store.saveHosts(hosts, host)
                        store.load()?.let(::renderComputer)
                        dialog.dismiss()
                        Toast.makeText(this, getString(R.string.address_saved, pc.pcName, host), Toast.LENGTH_LONG).show()
                        // Corta la espera y conecta ya, salvo que el usuario haya desconectado.
                        if (store.connectionWanted) TunnelService.retry(this)
                    }
                    is AddressCheck.OtherPc ->
                        status.text = getString(R.string.address_other_pc, host, pc.pcName, result.fingerprint)
                    is AddressCheck.Unreachable ->
                        status.text = getString(R.string.address_not_saved, Texts.problem(this, result.problem))
                }
                check.isEnabled = true
                input.isEnabled = true
            }
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
