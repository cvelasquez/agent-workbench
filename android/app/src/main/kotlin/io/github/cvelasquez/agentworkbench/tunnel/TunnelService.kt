package io.github.cvelasquez.agentworkbench.tunnel

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.util.Log
import io.github.cvelasquez.agentworkbench.BuildConfig
import io.github.cvelasquez.agentworkbench.R
import io.github.cvelasquez.agentworkbench.core.Backoff
import io.github.cvelasquez.agentworkbench.core.PhoneIdentity
import io.github.cvelasquez.agentworkbench.store.PcStore
import io.github.cvelasquez.agentworkbench.ui.MainActivity
import io.github.cvelasquez.agentworkbench.ui.Texts
import io.github.cvelasquez.agentworkbench.watch.ActivityWatcher
import io.github.cvelasquez.agentworkbench.watch.AgentNotifier
import java.io.IOException
import kotlin.concurrent.thread

/**
 * El servicio que mantiene la conexión con la PC (hito 38, §15).
 *
 * Es un servicio en primer plano de tipo `connectedDevice` —el de KDE Connect,
 * que también empareja el teléfono con una PC por la red (S3)— y lleva el aviso
 * fijo que Android exige, con "Desconectar". Medido en el hito: así conserva la
 * red con el teléfono en reposo profundo, sin pedir la excepción de batería.
 *
 * Un solo hilo hace todo en orden: abre el túnel, comprueba que Agent Workbench
 * contesta, engancha el vigía, y mientras tanto manda un ping cada 15 s. Si algo
 * falla, espera con `Backoff` —un cambio de red corta la espera— y vuelve a
 * empezar. Dos cosas no se reintentan solas, porque las decide el usuario: una
 * huella de la PC distinta y un teléfono que la app ya no acepta.
 */
class TunnelService : Service() {
    companion object {
        private const val TAG = "AgentWorkbench"
        private const val NOTIFICATION_ID = 1
        private const val PING_EVERY_MS = 15_000L
        const val ACTION_STOP = "io.github.cvelasquez.agentworkbench.action.STOP"
        const val ACTION_RETRY = "io.github.cvelasquez.agentworkbench.action.RETRY"

        /** Conecta. Sólo desde una pantalla a la vista: Android no deja arrancar el servicio desde el fondo. */
        fun start(context: Context) {
            PcStore(context).connectionWanted = true
            context.startForegroundService(Intent(context, TunnelService::class.java))
        }

        /**
         * Recién emparejado: conecta con la credencial nueva. Si el servicio seguía
         * vivo y parado en "no aceptado" (el teléfono estaba revocado), eso se olvida:
         * con `start` a secas se quedaba ahí y había que cerrar la app.
         */
        fun startAfterPairing(context: Context) {
            PcStore(context).connectionWanted = true
            context.startForegroundService(Intent(context, TunnelService::class.java).setAction(ACTION_RETRY))
        }

        /** Corta ya la espera y vuelve a intentar. */
        fun retry(context: Context) {
            context.startForegroundService(Intent(context, TunnelService::class.java).setAction(ACTION_RETRY))
        }

        /** Desconecta, y no vuelve a conectar hasta que el usuario lo pida. */
        fun stop(context: Context) {
            PcStore(context).connectionWanted = false
            context.stopService(Intent(context, TunnelService::class.java))
            Tunnel.publish(TunnelStatus.Idle)
        }
    }

    private lateinit var store: PcStore
    private lateinit var userAgent: String
    private var watcher: ActivityWatcher? = null
    private var worker: Thread? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    @Volatile
    private var running = false

    @Volatile
    private var notAccepted = false
    private val lock = Object()
    private var wakeRequested = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        store = PcStore(this)
        val deviceName = Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME) ?: Build.MODEL
        userAgent = PhoneIdentity.userAgent(BuildConfig.VERSION_NAME, Build.VERSION.RELEASE, deviceName)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, ongoing(getString(R.string.status_connecting, store.load()?.pcName ?: "")), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        if (intent?.action == ACTION_STOP) {
            stop(this)
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_RETRY) notAccepted = false
        if (!running) {
            running = true
            watchNetwork()
            worker = thread(name = "tunnel") { runLoop() }
        } else {
            wake()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        wake()
        worker?.interrupt()
        networkCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        watcher?.shutdown()
        watcher = null
        super.onDestroy()
    }

    // ---- El bucle ------------------------------------------------------------------

    private fun runLoop() {
        val backoff = Backoff()
        while (running) {
            val pc = store.load()
            val seed = store.seed()
            val credential = store.credential()
            if (pc == null || seed == null || credential == null) {
                // Sin PC emparejada no hay nada que sostener: el servicio se va, y la
                // pantalla principal lleva a emparejar.
                Tunnel.publish(TunnelStatus.Blocked(TunnelProblem.NotPaired))
                running = false
                stopSelf()
                return
            }
            if (notAccepted) {
                blocked(TunnelProblem.NotAccepted)
                sleep(Long.MAX_VALUE)
                continue
            }

            Tunnel.publish(TunnelStatus.Connecting(pc.pcName))
            updateNotification(getString(R.string.status_connecting, pc.pcName))
            val target = SshTarget(pc.hosts, pc.sshPort, pc.user, seed, pc.hostKeyAlgorithm, pc.hostKey, pc.appPort)
            when (val outcome = SshSession.open(target)) {
                is SshSession.Outcome.Down -> {
                    if (outcome.problem is TunnelProblem.HostKeyChanged) {
                        blocked(outcome.problem)
                        sleep(Long.MAX_VALUE)
                        continue
                    }
                    waitAndRetry(backoff, outcome.problem)
                }
                is SshSession.Outcome.Up -> {
                    val session = outcome.session
                    store.rememberHost(session.host)
                    when (val check = AppProbe.check(pc.appPort, credential, userAgent)) {
                        AppProbe.Check.Ok -> {
                            backoff.reset()
                            Tunnel.publish(TunnelStatus.Connected(pc.pcName, session.host))
                            updateNotification(getString(R.string.status_connected, pc.pcName))
                            watcher().resume(pc.appPort, credential, pc.pcName)
                            holdWhileAlive(session)
                            watcher?.pause()
                            session.close()
                        }
                        AppProbe.Check.NotAccepted -> {
                            session.close()
                            notAccepted = true
                        }
                        AppProbe.Check.NotReachable -> {
                            session.close()
                            waitAndRetry(backoff, TunnelProblem.AppNotRunning)
                        }
                        is AppProbe.Check.Unexpected -> {
                            session.close()
                            waitAndRetry(backoff, TunnelProblem.Other("HTTP ${check.status}"))
                        }
                    }
                }
            }
        }
    }

    /** Mientras el túnel viva: un ping cada 15 s, o antes si cambió la red. */
    private fun holdWhileAlive(session: SshSession) {
        while (running && !notAccepted && session.lostReason == null) {
            sleep(PING_EVERY_MS)
            if (!running || notAccepted || session.lostReason != null) break
            try {
                session.ping()
            } catch (error: IOException) {
                if (BuildConfig.DEBUG) Log.i(TAG, "ping failed: $error")
                break
            }
        }
    }

    private fun waitAndRetry(backoff: Backoff, problem: TunnelProblem) {
        val delay = backoff.next()
        Tunnel.publish(TunnelStatus.Waiting(problem, System.currentTimeMillis() + delay))
        updateNotification(getString(R.string.status_retrying, (delay / 1000).toInt()))
        if (BuildConfig.DEBUG) Log.i(TAG, "tunnel down: $problem, retry in ${delay}ms")
        sleep(delay)
    }

    private fun blocked(problem: TunnelProblem) {
        Tunnel.publish(TunnelStatus.Blocked(problem))
        updateNotification(Texts.problem(this, problem))
    }

    private fun sleep(ms: Long) {
        synchronized(lock) {
            if (!wakeRequested && running) {
                try {
                    lock.wait(ms.coerceAtMost(Long.MAX_VALUE / 2))
                } catch (_: InterruptedException) {
                    // Se apaga el servicio.
                }
            }
            wakeRequested = false
        }
    }

    private fun wake() {
        synchronized(lock) {
            wakeRequested = true
            lock.notifyAll()
        }
    }

    private fun watcher(): ActivityWatcher =
        watcher ?: ActivityWatcher(this, store, userAgent) {
            notAccepted = true
            wake()
        }.also { watcher = it }

    /** Un cambio de red corta la espera: el wifi que vuelve se nota enseguida. */
    private fun watchNetwork() {
        val manager = getSystemService(ConnectivityManager::class.java)
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = wake()
            override fun onLost(network: Network) = wake()
        }
        val request = NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build()
        runCatching { manager.registerNetworkCallback(request, callback) }.onSuccess { networkCallback = callback }
    }

    // ---- El aviso fijo -------------------------------------------------------------

    private fun ongoing(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val disconnect = PendingIntent.getService(
            this,
            1,
            Intent(this, TunnelService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, AgentNotifier.CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, getString(R.string.action_disconnect), disconnect).build())
            .build()
    }

    private fun updateNotification(text: String) {
        if (!running) return
        getSystemService(android.app.NotificationManager::class.java).notify(NOTIFICATION_ID, ongoing(text))
    }
}
