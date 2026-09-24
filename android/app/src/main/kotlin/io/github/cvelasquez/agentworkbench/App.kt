package io.github.cvelasquez.agentworkbench

import android.app.Application
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import io.github.cvelasquez.agentworkbench.ui.SettingsActivity
import io.github.cvelasquez.agentworkbench.watch.AgentNotifier

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        AgentNotifier.createChannels(this)
        publishShortcuts()
    }

    /**
     * Mantener apretado el ícono lleva a los ajustes. Se publica al arrancar y no
     * en un XML: el XML no sabe del sufijo `.dev` de la versión de desarrollo.
     */
    private fun publishShortcuts() {
        val settings = ShortcutInfo.Builder(this, "settings")
            .setShortLabel(getString(R.string.shortcut_settings))
            .setIcon(Icon.createWithResource(this, R.drawable.ic_shortcut_settings))
            .setIntent(Intent(this, SettingsActivity::class.java).setAction(Intent.ACTION_VIEW))
            .build()
        runCatching { getSystemService(ShortcutManager::class.java).dynamicShortcuts = listOf(settings) }
    }
}
