package io.github.cvelasquez.agentworkbench.watch

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import io.github.cvelasquez.agentworkbench.R
import io.github.cvelasquez.agentworkbench.core.Chime
import io.github.cvelasquez.agentworkbench.ui.MainActivity

/**
 * Los avisos del teléfono. Salen del teléfono mismo, no de un servidor de
 * Google: la PC no llama a nadie (§2.4) y el aviso puede nombrar la pestaña,
 * porque no sale de la red de la casa.
 *
 * Uno por pestaña: un aviso nuevo de la misma reemplaza al anterior. Tocarlo
 * abre la app en esa pestaña (`/?tab=<id>`).
 */
object AgentNotifier {
    const val CHANNEL_CONNECTION = "connection"
    /** Uno por sonido: Android fija el sonido al crear el canal y no deja cambiarlo. */
    const val CHANNEL_DONE = "agent_done"
    const val CHANNEL_ATTENTION = "agent_attention"
    /** Sin sonido: cuando el sonido lo pone la página (`PcStore.chimeFromPage`). */
    const val CHANNEL_QUIET = "agent_quiet"
    private const val GROUP_AGENT = "agent"

    /** El canal de antes, con el sonido del teléfono. Se borra al arrancar. */
    private const val OLD_CHANNEL_AGENT = "agent"
    private const val TAG_AGENT = "agent"

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_CONNECTION, context.getString(R.string.channel_connection), NotificationManager.IMPORTANCE_LOW).apply {
                description = context.getString(R.string.channel_connection_description)
                setShowBadge(false)
            },
        )
        manager.deleteNotificationChannel(OLD_CHANNEL_AGENT)
        manager.createNotificationChannelGroup(
            NotificationChannelGroup(GROUP_AGENT, context.getString(R.string.channel_agent)).apply {
                description = context.getString(R.string.channel_agent_description)
            },
        )
        agentChannel(context, manager, CHANNEL_DONE, R.string.channel_agent_done, R.raw.chime_done)
        agentChannel(context, manager, CHANNEL_ATTENTION, R.string.channel_agent_attention, R.raw.chime_attention)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_QUIET, context.getString(R.string.channel_agent_quiet), NotificationManager.IMPORTANCE_HIGH).apply {
                group = GROUP_AGENT
                setSound(null, null)
            },
        )
    }

    private val chimeAttributes: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    private fun soundUri(context: Context, sound: Int): Uri = Uri.parse("android.resource://${context.packageName}/$sound")

    /** Los sonidos de la web (`chimeSounds` en `build.gradle.kts`), no el del teléfono. */
    private fun agentChannel(context: Context, manager: NotificationManager, id: String, name: Int, sound: Int) {
        manager.createNotificationChannel(
            NotificationChannel(id, context.getString(name), NotificationManager.IMPORTANCE_HIGH).apply {
                group = GROUP_AGENT
                setSound(soundUri(context, sound), chimeAttributes)
            },
        )
    }

    /**
     * Sólo el sonido, sin aviso: con la interfaz a la vista y el sonido "del
     * sistema", la página calla y el aviso sobra.
     */
    fun playChime(context: Context, chime: Chime) {
        val sound = if (chime == Chime.DONE) R.raw.chime_done else R.raw.chime_attention
        runCatching {
            RingtoneManager.getRingtone(context, soundUri(context, sound))?.apply { audioAttributes = chimeAttributes }?.play()
        }
    }

    /** `body`: el proyecto y la PC (`ServerMessage.noticeBody`). `silent`: el sonido lo pone la página. */
    fun show(context: Context, terminalId: String, tabName: String, chime: Chime, body: String, silent: Boolean = false) {
        val id = notificationId(terminalId)
        val open = PendingIntent.getActivity(
            context,
            id,
            Intent(context, MainActivity::class.java)
                .setAction(MainActivity.ACTION_OPEN_TAB)
                .putExtra(MainActivity.EXTRA_TAB, terminalId)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val title = when (chime) {
            Chime.DONE -> context.getString(R.string.notify_done, tabName)
            Chime.ATTENTION -> context.getString(R.string.notify_attention, tabName)
        }
        val channel = when {
            silent -> CHANNEL_QUIET
            chime == Chime.DONE -> CHANNEL_DONE
            else -> CHANNEL_ATTENTION
        }
        val notification = Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle(title)
            .setContentText(body)
            .setCategory(if (chime == Chime.ATTENTION) Notification.CATEGORY_REMINDER else Notification.CATEGORY_STATUS)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(TAG_AGENT, id, notification)
    }

    /** Con la app a la vista, los avisos pendientes ya no dicen nada nuevo. */
    fun cancelAll(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        for (active in manager.activeNotifications) {
            if (active.tag == TAG_AGENT) manager.cancel(TAG_AGENT, active.id)
        }
    }

    /** Estable por pestaña, y nunca el del aviso fijo del servicio. */
    private fun notificationId(terminalId: String): Int = (terminalId.hashCode() and 0x7fffffff).coerceAtLeast(1000)
}
