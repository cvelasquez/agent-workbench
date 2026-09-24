package io.github.cvelasquez.agentworkbench.watch

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
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
    const val CHANNEL_AGENT = "agent"
    private const val TAG_AGENT = "agent"

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_CONNECTION, context.getString(R.string.channel_connection), NotificationManager.IMPORTANCE_LOW).apply {
                description = context.getString(R.string.channel_connection_description)
                setShowBadge(false)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_AGENT, context.getString(R.string.channel_agent), NotificationManager.IMPORTANCE_HIGH).apply {
                description = context.getString(R.string.channel_agent_description)
            },
        )
    }

    fun show(context: Context, terminalId: String, tabName: String, chime: Chime, pcName: String) {
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
        val notification = Notification.Builder(context, CHANNEL_AGENT)
            .setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle(title)
            .setContentText(pcName)
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
