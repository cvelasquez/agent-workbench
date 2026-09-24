package io.github.cvelasquez.agentworkbench.ui

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import com.google.zxing.integration.android.IntentIntegrator
import io.github.cvelasquez.agentworkbench.BuildConfig
import io.github.cvelasquez.agentworkbench.R
import io.github.cvelasquez.agentworkbench.core.PairingPayload
import io.github.cvelasquez.agentworkbench.core.PhoneIdentity
import io.github.cvelasquez.agentworkbench.store.PcStore
import io.github.cvelasquez.agentworkbench.tunnel.AppProbe
import io.github.cvelasquez.agentworkbench.tunnel.SshSession
import io.github.cvelasquez.agentworkbench.tunnel.SshTarget
import io.github.cvelasquez.agentworkbench.tunnel.TunnelProblem
import io.github.cvelasquez.agentworkbench.tunnel.TunnelService
import kotlin.concurrent.thread

/**
 * Emparejar (hito 38, §15): leer el QR del diálogo "Acceso remoto" de la PC,
 * abrir el túnel con la llave que trae, y canjear el código por la credencial
 * del equipo.
 *
 * El orden importa para el usuario. Puede escanear antes de haber pegado en la
 * PC la línea que autoriza la llave: mientras la PC la rechace, el teléfono
 * dice qué falta y sigue intentando. El código vence a los cinco minutos; si
 * vence, la PC da otro con la misma llave, y la línea pegada sigue valiendo.
 *
 * La huella de la PC se fija acá, en la primera conexión (TOFU): es lo que
 * decidió el plan.
 */
class PairingActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private lateinit var scan: Button
    private lateinit var cancel: Button
    private lateinit var pasteBox: View
    private lateinit var pasteText: EditText

    @Volatile
    private var running = false
    private var worker: Thread? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Orientation.apply(this)
        setContentView(R.layout.activity_pairing)
        edgeToEdge()
        status = findViewById(R.id.status)
        progress = findViewById(R.id.progress)
        scan = findViewById(R.id.scan)
        cancel = findViewById(R.id.cancel)
        pasteBox = findViewById(R.id.pasteBox)
        pasteText = findViewById(R.id.pasteText)

        // Si había una conexión con otra PC, suelta el puerto que el túnel necesita.
        TunnelService.stop(this)

        scan.setOnClickListener {
            IntentIntegrator(this)
                .setCaptureActivity(ScanActivity::class.java)
                .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
                .setPrompt(getString(R.string.scan_prompt))
                .setBeepEnabled(false)
                .setOrientationLocked(false)
                .initiateScan()
        }
        findViewById<Button>(R.id.pasteToggle).setOnClickListener {
            pasteBox.visibility = if (pasteBox.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }
        findViewById<Button>(R.id.pasteUse).setOnClickListener { usePayload(pasteText.text.toString()) }
        // Una sola línea para el teclado, que así ofrece "Ir" y aplica el texto sin
        // tener que bajar hasta el botón; en pantalla, el texto largo se parte.
        pasteText.setHorizontallyScrolling(false)
        pasteText.minLines = 2
        pasteText.maxLines = 5
        pasteText.setOnEditorActionListener { _, actionId, event ->
            // Un Enter de un teclado físico llega como IME_NULL, al bajar y al subir.
            val enter = actionId == EditorInfo.IME_NULL && event?.keyCode == KeyEvent.KEYCODE_ENTER
            if (actionId != EditorInfo.IME_ACTION_GO && !enter) return@setOnEditorActionListener false
            if (event == null || event.action == KeyEvent.ACTION_DOWN) usePayload(pasteText.text.toString())
            true
        }
        cancel.setOnClickListener { stopPairing(null) }
    }

    @Deprecated("El lector de QR devuelve su resultado por acá.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (result != null) {
            result.contents?.let { usePayload(it) }
            return
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onDestroy() {
        running = false
        worker?.interrupt()
        super.onDestroy()
    }

    private fun usePayload(text: String) {
        val payload = PairingPayload.parse(text)
        if (payload == null) {
            status.text = getString(R.string.pair_invalid)
            return
        }
        // El teclado se va: lo que sigue es un diálogo y, después, el progreso.
        getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(pasteText.windowToken, 0)
        AlertDialog.Builder(this)
            .setMessage(getString(R.string.pair_confirm, payload.pcName, "${payload.user}@${payload.hosts.first()}"))
            .setPositiveButton(R.string.pair_confirm_ok) { _, _ -> startPairing(payload) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun startPairing(payload: PairingPayload) {
        running = true
        scan.isEnabled = false
        progress.visibility = View.VISIBLE
        cancel.visibility = View.VISIBLE
        pasteBox.visibility = View.GONE
        status.text = getString(R.string.pair_connecting, payload.pcName)
        worker = thread(name = "pairing") { pair(payload) }
    }

    private fun stopPairing(message: String?) {
        running = false
        worker?.interrupt()
        scan.isEnabled = true
        progress.visibility = View.GONE
        cancel.visibility = View.GONE
        status.text = message ?: ""
    }

    private fun show(text: String) = runOnUiThread { if (running) status.text = text }

    private fun fail(text: String) = runOnUiThread { stopPairing(text) }

    private fun pair(payload: PairingPayload) {
        val deviceName = Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME) ?: Build.MODEL
        val userAgent = PhoneIdentity.userAgent(BuildConfig.VERSION_NAME, Build.VERSION.RELEASE, deviceName)
        val target = SshTarget(payload.hosts, payload.sshPort, payload.user, payload.seed, null, null, payload.appPort)
        val deadline = System.currentTimeMillis() + PAIRING_WINDOW_MS

        while (running && System.currentTimeMillis() < deadline) {
            show(getString(R.string.pair_connecting, payload.pcName))
            when (val outcome = SshSession.open(target)) {
                is SshSession.Outcome.Down -> when (val problem = outcome.problem) {
                    // Todavía no se pegó la línea en la PC: se espera y se reintenta.
                    TunnelProblem.KeyRejected -> {
                        show(getString(R.string.pair_waiting_key))
                        if (!pause(3_000)) return
                    }
                    // Otra red, la PC apagada o su SSH cerrado: puede arreglarse sin salir de acá.
                    TunnelProblem.PcNotFound, TunnelProblem.SshClosed -> {
                        show(Texts.problem(this, problem))
                        if (!pause(5_000)) return
                    }
                    else -> {
                        fail(Texts.problem(this, problem))
                        return
                    }
                }
                is SshSession.Outcome.Up -> {
                    val session = outcome.session
                    show(getString(R.string.pair_redeeming))
                    val redeemed = AppProbe.redeem(payload.appPort, payload.code, userAgent)
                    session.close()
                    when (redeemed) {
                        is AppProbe.Redeem.Paired -> {
                            PcStore(this).savePairing(payload, session.host, session.hostKeyAlgorithm, session.hostKey, redeemed.credential)
                            runOnUiThread {
                                running = false
                                TunnelService.startAfterPairing(this)
                                startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                                finish()
                            }
                        }
                        AppProbe.Redeem.CodeRejected -> fail(getString(R.string.pair_code_rejected))
                        AppProbe.Redeem.NotReachable -> fail(getString(R.string.problem_app_not_running))
                        is AppProbe.Redeem.Unexpected -> fail(getString(R.string.problem_other, "HTTP ${redeemed.status}"))
                    }
                    return
                }
            }
        }
        if (running) fail(getString(R.string.pair_code_rejected))
    }

    /** Espera, salvo que se cancele. false: se canceló. */
    private fun pause(ms: Long): Boolean = try {
        Thread.sleep(ms)
        running
    } catch (_: InterruptedException) {
        false
    }

    private companion object {
        /** El código vale cinco minutos (§14.3): esperar más no sirve. Un margen, por si el reloj difiere. */
        const val PAIRING_WINDOW_MS = 6 * 60_000L
    }
}
