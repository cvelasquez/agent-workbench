package io.github.cvelasquez.agentworkbench.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.window.OnBackInvokedDispatcher
import io.github.cvelasquez.agentworkbench.BuildConfig
import io.github.cvelasquez.agentworkbench.R
import io.github.cvelasquez.agentworkbench.core.PhoneIdentity
import io.github.cvelasquez.agentworkbench.store.PairedPc
import io.github.cvelasquez.agentworkbench.store.PcStore
import io.github.cvelasquez.agentworkbench.tunnel.AppProbe
import io.github.cvelasquez.agentworkbench.tunnel.Tunnel
import io.github.cvelasquez.agentworkbench.tunnel.TunnelProblem
import io.github.cvelasquez.agentworkbench.tunnel.TunnelService
import io.github.cvelasquez.agentworkbench.tunnel.TunnelStatus
import io.github.cvelasquez.agentworkbench.watch.AgentNotifier

/**
 * La pantalla principal (hito 38, §15): **la interfaz que sirve la PC**, en un
 * visor a pantalla completa, por el túnel. La app no trae una copia de la
 * interfaz: nunca queda desactualizada respecto del servidor.
 *
 *  - Arriba de todo, una capa con el estado de la conexión mientras la
 *    interfaz no cargó, o cuando hace falta que el usuario haga algo. Con la
 *    interfaz cargada, un corte breve lo muestra la propia web ("Reconectando")
 *    y se recupera sola (S5).
 *  - El botón Atrás le pregunta primero a la web (`window.agentWorkbenchBack`,
 *    en `NarrowShell.tsx`): cierra un diálogo, una hoja o el cajón, o vuelve al
 *    chat. Si no queda nada, la app se va al fondo con la conexión abierta.
 *  - Un aviso tocado abre su pestaña: `/?tab=<id>`, que la web respeta desde la
 *    Fase A.
 *  - La hoja `⋮` de la web ofrece los ajustes de la app con una dirección
 *    `agentworkbench://settings`, que el visor intercepta (y `…://disconnect`,
 *    que corta el túnel). Nada de puentes de
 *    JavaScript hacia el teléfono.
 */
class MainActivity : Activity() {
    companion object {
        const val ACTION_OPEN_TAB = "io.github.cvelasquez.agentworkbench.action.OPEN_TAB"
        const val EXTRA_TAB = "tab"
        private const val REQUEST_FILES = 7
        private const val REQUEST_NOTIFICATIONS = 8
        private const val TAG = "AgentWorkbench"
    }

    private lateinit var store: PcStore
    private lateinit var pc: PairedPc
    private lateinit var credential: String
    private lateinit var web: WebView
    private lateinit var overlay: LinearLayout
    private lateinit var overlayText: TextView
    private lateinit var overlayProgress: ProgressBar
    private lateinit var overlayPrimary: Button
    private lateinit var overlaySecondary: Button

    /** La interfaz cargó en este visor: de ahí en más los cortes breves los muestra la web. */
    private var loaded = false
    private var loading = false
    private var pendingTab: String? = null
    private var filesCallback: ValueCallback<Array<Uri>>? = null
    private var stopObserving: (() -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Orientation.apply(this)
        store = PcStore(this)
        val paired = store.load()
        val saved = store.credential()
        if (paired == null || saved == null) {
            startActivity(Intent(this, PairingActivity::class.java))
            finish()
            return
        }
        pc = paired
        credential = saved
        pendingTab = tabOf(intent)
        buildViews()
        registerBack()
        askForNotifications()
        if (store.connectionWanted) TunnelService.start(this)
    }

    override fun onResume() {
        super.onResume()
        if (!::web.isInitialized) return
        pickUpNewPairing()
        Tunnel.uiVisible = true
        AgentNotifier.cancelAll(this)
        stopObserving = Tunnel.observe(::render)
    }

    override fun onPause() {
        Tunnel.uiVisible = false
        stopObserving?.invoke()
        stopObserving = null
        super.onPause()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val tab = tabOf(intent) ?: return
        if (loaded) loadUi(tab) else pendingTab = tab
    }

    /** Maneja sus cambios de pantalla (manifiesto): un plegable que se abre pasa a tablet acá. */
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        Orientation.apply(this)
    }

    override fun onDestroy() {
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }

    /**
     * Emparejado otra vez sin que esta pantalla se cerrara. Es `singleTask`: al
     * volver de emparejar, Android reusa esta misma, con la credencial vieja en
     * memoria y la web parada en "Acceso revocado", que no reconecta a propósito.
     * Si la credencial guardada cambió, se toma la nueva y la interfaz se carga
     * de cero cuando el túnel esté arriba (`render`, que `observe` llama enseguida).
     */
    private fun pickUpNewPairing() {
        val paired = store.load() ?: return
        val saved = store.credential() ?: return
        if (saved == credential) return
        pc = paired
        credential = saved
        loaded = false
        loading = false
    }

    private fun tabOf(intent: Intent?): String? =
        intent?.takeIf { it.action == ACTION_OPEN_TAB }?.getStringExtra(EXTRA_TAB)?.takeIf { Regex("^[A-Za-z0-9_-]{1,80}$").matches(it) }

    // ---- La vista ---------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildViews() {
        val root = FrameLayout(this)
        root.setBackgroundColor(resources.getColor(if (isNight()) R.color.surface_dark else R.color.surface, theme))
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web = WebView(this)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            userAgentString = PhoneIdentity.webViewUserAgent(userAgentString, BuildConfig.VERSION_NAME)
        }
        web.webViewClient = Client()
        web.webChromeClient = Chrome()
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        overlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            val padding = dp(32)
            setPadding(padding, padding, padding, padding)
            setBackgroundColor(resources.getColor(if (isNight()) R.color.surface_dark else R.color.surface, theme))
            isClickable = true
        }
        overlayProgress = ProgressBar(this).apply { isIndeterminate = true }
        overlayText = TextView(this).apply {
            gravity = Gravity.CENTER
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            setPadding(0, dp(16), 0, dp(16))
        }
        overlayPrimary = Button(this)
        overlaySecondary = Button(this, null, android.R.attr.borderlessButtonStyle)
        overlay.addView(overlayProgress)
        overlay.addView(overlayText, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        overlay.addView(overlayPrimary)
        overlay.addView(overlaySecondary)
        root.addView(overlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        setContentView(root)
        edgeToEdge()
    }

    private fun isNight(): Boolean =
        (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    /** La capa encima de la interfaz: un texto, y hasta dos acciones. */
    private fun showOverlay(text: String, busy: Boolean, primary: Pair<Int, () -> Unit>?, secondary: Pair<Int, () -> Unit>?) {
        overlay.visibility = View.VISIBLE
        overlayText.text = text
        overlayProgress.visibility = if (busy) View.VISIBLE else View.GONE
        bind(overlayPrimary, primary)
        bind(overlaySecondary, secondary)
    }

    private fun bind(button: Button, action: Pair<Int, () -> Unit>?) {
        if (action == null) {
            button.visibility = View.GONE
            return
        }
        button.visibility = View.VISIBLE
        button.setText(action.first)
        button.setOnClickListener { action.second() }
    }

    private fun hideOverlay() {
        overlay.visibility = View.GONE
    }

    // ---- La conexión ---------------------------------------------------------------

    private val openSettings: Pair<Int, () -> Unit> = R.string.action_settings to { startActivity(Intent(this, SettingsActivity::class.java)) }
    private val retry: Pair<Int, () -> Unit> = R.string.action_retry to { TunnelService.retry(this) }
    private val pairAgain: Pair<Int, () -> Unit> = R.string.action_pair_again to { startActivity(Intent(this, PairingActivity::class.java)) }
    private val connect: Pair<Int, () -> Unit> = R.string.settings_connect to { TunnelService.start(this) }

    private fun render(status: TunnelStatus) {
        when (status) {
            is TunnelStatus.Connected -> {
                if (!loaded && !loading) loadUi(pendingTab)
                if (loaded) hideOverlay()
            }
            is TunnelStatus.Connecting ->
                if (!loaded) showOverlay(getString(R.string.status_connecting, status.pcName), busy = true, primary = null, secondary = openSettings)
            is TunnelStatus.Waiting -> if (!loaded) {
                val seconds = ((status.retryAt - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
                val text = Texts.problem(this, status.problem) + "\n\n" + getString(R.string.status_retrying, seconds.toInt())
                showOverlay(text, busy = false, primary = retry, secondary = openSettings)
            }
            is TunnelStatus.Blocked -> {
                val needsPairing = status.problem is TunnelProblem.NotAccepted || status.problem is TunnelProblem.HostKeyChanged ||
                    status.problem is TunnelProblem.NotPaired
                showOverlay(
                    Texts.problem(this, status.problem),
                    busy = false,
                    primary = if (needsPairing) pairAgain else retry,
                    secondary = openSettings,
                )
            }
            TunnelStatus.Idle -> showOverlay(getString(R.string.status_disconnected), busy = false, primary = connect, secondary = openSettings)
        }
    }

    /** Carga la interfaz de la PC, con la credencial del equipo en su cookie. */
    private fun loadUi(tab: String?) {
        pendingTab = null
        loading = true
        val origin = "http://127.0.0.1:${pc.appPort}"
        val url = if (tab == null) "$origin/" else "$origin/?tab=${Uri.encode(tab)}"
        val cookies = CookieManager.getInstance()
        cookies.setCookie(origin, "${AppProbe.DEVICE_COOKIE}=$credential; Path=/; Max-Age=34560000; SameSite=Strict; HttpOnly") {
            cookies.flush()
            web.loadUrl(url)
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (url.scheme == "agentworkbench" && url.host == "settings") {
                startActivity(Intent(this@MainActivity, SettingsActivity::class.java))
                return true
            }
            // "Desconectar" de la hoja ⋮: corta el túnel y queda la capa con "Conectar".
            if (url.scheme == "agentworkbench" && url.host == "disconnect") {
                TunnelService.stop(this@MainActivity)
                return true
            }
            // De dónde sale el sonido, elegido en la hoja ⋮ (`phoneChimeUrl` de la web).
            if (url.scheme == "agentworkbench" && url.host == "chime") {
                store.chimeFromPage = url.getQueryParameter("source") == "page"
                return true
            }
            val local = url.scheme == "http" && (url.host == "127.0.0.1" || url.host == "localhost") && url.port == pc.appPort
            if (local) return false
            // Un enlace de afuera se abre en el navegador, no en el visor de la app.
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
            return true
        }

        override fun onPageFinished(view: WebView, url: String) {
            loading = false
            if (url.startsWith("http://127.0.0.1:")) {
                loaded = true
                if (Tunnel.status is TunnelStatus.Connected) hideOverlay()
                // La preferencia del sonido vive en la página; la app se queda con una copia.
                view.evaluateJavascript("(function(){try{return localStorage.getItem('agent-workbench.phone-chime');}catch(e){return null;}})()") {
                    store.chimeFromPage = it == "\"page\""
                }
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            loading = false
            loaded = false
            showOverlay(getString(R.string.load_error, error.description), busy = false, primary = retry, secondary = openSettings)
        }
    }

    private inner class Chrome : WebChromeClient() {
        /** El 📎 del cuadro de escritura: el selector de archivos del sistema. */
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            filesCallback?.onReceiveValue(null)
            filesCallback = callback
            val intent = params.createIntent().apply {
                if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
            return runCatching {
                @Suppress("DEPRECATION")
                startActivityForResult(intent, REQUEST_FILES)
                true
            }.getOrElse {
                filesCallback = null
                false
            }
        }

        /** Cámara, micrófono y el resto: la interfaz no los usa. */
        override fun onPermissionRequest(request: PermissionRequest) = request.deny()

        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            if (BuildConfig.DEBUG) Log.d(TAG, "web: ${message.message()}")
            return true
        }
    }

    @Deprecated("El selector de archivos devuelve su resultado por acá.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST_FILES) {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        val callback = filesCallback ?: return
        filesCallback = null
        val clip: ClipData? = data?.clipData
        val uris = when {
            resultCode != RESULT_OK -> null
            clip != null -> Array(clip.itemCount) { clip.getItemAt(it).uri }
            else -> WebChromeClient.FileChooserParams.parseResult(resultCode, data)
        }
        callback.onReceiveValue(uris)
    }

    // ---- Atrás y avisos --------------------------------------------------------------

    /** Desde la API 33 con el despachador (con la 36, `onBackPressed` ya no se llama); antes, el de siempre. */
    private fun registerBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { handleBack() }
        }
    }

    // Lint marca todo onBackPressed porque con la API 36 el gesto ya no lo llama.
    // Acá no hace falta: desde la 33 Atrás va por el despachador del sistema
    // (registerBack), y esto sólo corre en Android 10 a 12, sin gesto predictivo.
    @SuppressLint("GestureBackNavigation")
    @Deprecated("Sólo hasta la API 32; después va por registerBack().")
    override fun onBackPressed() {
        handleBack()
    }

    private fun handleBack() {
        if (!loaded) {
            moveTaskToBack(true)
            return
        }
        web.evaluateJavascript(
            "(function(){try{return !!(window.agentWorkbenchBack&&window.agentWorkbenchBack());}catch(e){return false;}})()",
        ) { result -> if (result != "true") moveTaskToBack(true) }
    }

    /** Android 13 pide permiso para avisar. Se pide una vez, al abrir la app ya emparejada. */
    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
    }
}
